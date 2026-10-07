import { EventStore } from './event-store';
import { EvidenceLedger, acceptedBindings, bindingFor } from '../domain/evidence';
import { PolicyCatalog } from '../domain/policy';
import { RuleEngine } from '../domain/rules';
import {
  ClaimReportedPayload,
  ClaimState,
  DomainEvent,
  EvidenceBinding,
  EvidenceRecord,
  EvidenceReview,
  InvestigationConclusion,
  VerificationCondition,
  VerificationHistoryEntry,
  VerificationStatus,
} from '../domain/types';
import { newId, iso } from '../domain/ids';

export class ClaimService {
  constructor(private readonly events: EventStore, private readonly policies: PolicyCatalog, private readonly rules: RuleEngine, private readonly evidence: EvidenceLedger) {}

  create(input: ClaimReportedPayload, actor: string, key?: string): ClaimState {
    const id = newId('claim');
    this.events.append(id, 'claim.reported', { ...input, lossAt: iso(input.lossAt), reportedAt: iso(input.reportedAt) }, actor, key);
    this.events.append(id, 'policy.snapshot.created', { policy: this.policies.snapshot(input.policyId, input.lossAt), ruleSnapshot: this.rules.freeze() }, 'system', `policy:${id}`);
    return this.get(id);
  }

  addEvent(id: string, type: DomainEvent['type'], payload: unknown, actor: string, key?: string, occurredAt?: string): ClaimState { this.assertExists(id); this.events.append(id, type, payload, actor, key, occurredAt); return this.get(id); }

  addEvidence(id: string, input: { kind: string; source: string; content: unknown; receivedAt?: string; supersedes?: string }, actor: string, key?: string): ClaimState {
    const claim = this.get(id);
    const record = this.evidence.add(input, claim.evidence);
    return this.addEvent(id, 'evidence.added', { evidence: record }, actor, key, input.receivedAt);
  }

  reviewEvidence(id: string, evidenceId: string, accepted: boolean, actor: string, key?: string): ClaimState {
    const claim = this.get(id);
    const { record, review } = this.evidence.review(evidenceId, accepted, claim.evidence, actor);
    return this.addEvent(id, 'evidence.reviewed', { evidence: record, review }, actor, key);
  }

  withdrawEvidence(id: string, evidenceId: string, actor: string, key?: string): ClaimState {
    const claim = this.get(id);
    const record = this.evidence.withdraw(evidenceId, claim.evidence);
    return this.addEvent(id, 'evidence.withdrawn', { evidence: record }, actor, key);
  }

  approveAdjustment(id: string, actor: string, key?: string): ClaimState {
    const claim = this.get(id);
    if (!claim.ruleSnapshot) throw new Error('claim has no frozen rule snapshot');
    const decision = this.rules.evaluate(claim, claim.ruleSnapshot);
    if (decision.reasons.length) throw new Error(`adjustment blocked: ${decision.reasons.join('; ')}`);
    const basis = acceptedBindings(claim.evidence, claim.evidenceReviews);
    if (!basis.length) throw new Error('adjustment requires at least one currently accepted evidence item');
    const payload = {
      approvedMinor: decision.approvedMinor,
      requiredEvidence: decision.requiredEvidence,
      basis,
      ruleVersion: claim.ruleSnapshot.version,
      signals: decision.signals,
    };
    return this.addEvent(id, 'adjustment.approved', payload, actor, key);
  }

  get(id: string): ClaimState { return this.replay(id, this.events.list(id)); }
  replay(id: string, events: DomainEvent[]): ClaimState {
    const state = this.empty(id);
    for (const event of events.sort((a, b) => a.sequence - b.sequence)) this.apply(state, event);
    if (!state.policy) throw new Error(`claim ${id} has no policy snapshot`);
    return state;
  }

  private empty(id: string): ClaimState { return { id, policyId: '', status: 'reported', lossAt: '', reportedAt: '', channel: '', participants: [], loss: { currency: 'CNY', gross: 0 }, evidence: [], evidenceReviews: [], verifications: [], conclusions: [], policy: undefined, ruleSnapshot: undefined, requiredEvidence: new Set(), completedSurveys: [], pendingDocuments: [], riskSignals: [], riskScore: 0, payments: [], approvedMinor: 0, audit: [], processedEventIds: new Set(), version: 0 }; }
  private assertExists(id: string): void { if (this.events.list(id).length === 0) throw new Error(`unknown claim ${id}`); }

  private apply(state: ClaimState, event: DomainEvent): void {
    if (state.processedEventIds.has(event.id)) return;
    state.processedEventIds.add(event.id);
    state.version = event.sequence;
    const payload = event.payload as any;

    if (event.type === 'claim.reported') { state.policyId = payload.policyId; state.lossAt = payload.lossAt; state.reportedAt = payload.reportedAt; state.channel = payload.channel; state.participants = payload.participants; state.loss = payload.loss; state.status = 'reported'; }
    if (event.type === 'policy.snapshot.created') { state.policy = payload.policy; state.ruleSnapshot = payload.ruleSnapshot; }

    let verificationTrigger: { action: VerificationHistoryEntry['reason']; at: string } | undefined;

    if (event.type === 'evidence.added') {
      const incoming = this.normalizeRecord(payload.evidence as EvidenceRecord);
      for (const record of state.evidence) {
        if (record.kind === incoming.kind && record.state === 'active') {
          state.evidence = state.evidence.map((item) => item.id === record.id ? { ...item, state: 'superseded' as const, supersededBy: incoming.id } : item);
          state.evidenceReviews = state.evidenceReviews.map((review) => review.evidenceId === record.id && review.active ? { ...review, active: false, supersededBy: incoming.id } : review);
        }
      }
      state.evidence = [...state.evidence.filter((e) => e.id !== incoming.id), incoming];
      state.status = state.status === 'reported' ? 'investigating' : state.status;
      verificationTrigger = { action: 'evidence_replaced', at: event.occurredAt };
    }

    if (event.type === 'evidence.withdrawn') {
      const withdrawn = this.normalizeRecord(payload.evidence as EvidenceRecord);
      state.evidence = state.evidence.map((e) => e.id === withdrawn.id ? { ...withdrawn } : e);
      state.evidenceReviews = state.evidenceReviews.map((review) => review.evidenceId === withdrawn.id && review.active ? { ...review, active: false, supersededBy: withdrawn.id } : review);
      verificationTrigger = { action: 'evidence_withdrawn', at: event.occurredAt };
    }

    if (event.type === 'evidence.reviewed') {
      const review = this.normalizeReview(payload, event);
      // A decision applies only to the hash it was made against; later re-reviews supersede it.
      state.evidenceReviews = state.evidenceReviews.map((existing) => existing.evidenceId === review.evidenceId && existing.active ? { ...existing, active: false, supersededBy: review.id } : existing);
      state.evidenceReviews = [...state.evidenceReviews.filter((existing) => existing.id !== review.id), review];
      state.evidence = state.evidence.map((e) => e.id === review.evidenceId ? { ...e, reviewed: true, accepted: review.accepted } : e);
      verificationTrigger = { action: review.accepted ? 'evidence_accepted' : 'evidence_rejected', at: review.reviewedAt };
    }

    if (event.type === 'documents.requested') { state.pendingDocuments = [...new Set([...(state.pendingDocuments), ...(payload.kinds ?? [])])]; state.status = 'awaiting_documents'; }
    if (event.type === 'documents.received') { state.pendingDocuments = state.pendingDocuments.filter((kind) => !(payload.kinds ?? []).includes(kind)); if (!state.pendingDocuments.length) state.status = 'ready_for_adjustment'; }
    if (event.type === 'survey.completed') { state.completedSurveys = [...new Set([...state.completedSurveys, payload.taskId])]; }

    if (event.type === 'risk.assessed') {
      const basis = payload.basis ? [...payload.basis] as EvidenceBinding[] : acceptedBindings(state.evidence, state.evidenceReviews);
      const conclusion: InvestigationConclusion = {
        id: `conclusion_${event.aggregateId}_${event.sequence}_risk`,
        kind: 'risk',
        createdAt: event.occurredAt,
        sequence: event.sequence,
        eventId: event.id,
        basis,
        status: 'active',
        payload: { signals: payload.signals ?? [], score: payload.score ?? 0 },
      };
      state.conclusions = this.appendConclusion(state.conclusions, conclusion);
    }

    if (event.type === 'adjustment.approved') {
      const basis = payload.basis ? [...payload.basis] as EvidenceBinding[] : acceptedBindings(state.evidence, state.evidenceReviews);
      const conclusion: InvestigationConclusion = {
        id: `conclusion_${event.aggregateId}_${event.sequence}_adjustment`,
        kind: 'adjustment',
        createdAt: event.occurredAt,
        sequence: event.sequence,
        eventId: event.id,
        basis,
        status: 'active',
        payload: {
          approvedMinor: payload.approvedMinor,
          requiredEvidence: payload.requiredEvidence ?? [],
          ruleVersion: payload.ruleVersion ?? state.ruleSnapshot?.version,
          signals: payload.signals ?? [],
        },
      };
      state.conclusions = this.appendConclusion(state.conclusions, conclusion);
    }

    if (event.type === 'payment.settled' || event.type === 'payment.reversed') { state.payments = [...state.payments, payload.payment]; state.status = payload.payment.kind === 'reversal' ? 'reopened' : 'partially_paid'; }
    if (event.type === 'claim.reopened') state.status = 'reopened';
    if (event.type === 'claim.rejected') state.status = 'rejected';

    // New material versions invalidate every frozen conclusion that relied on them.
    const activeAdjustmentBefore = state.conclusions.some((c) => c.kind === 'adjustment' && c.status === 'active');
    this.invalidateConclusions(state, event, verificationTrigger?.action);
    const activeAdjustmentAfter = state.conclusions.some((c) => c.kind === 'adjustment' && c.status === 'active');
    const adjustmentJustInvalidated = activeAdjustmentBefore && !activeAdjustmentAfter;
    this.projectConclusions(state);

    if (verificationTrigger) this.recomputeVerifications(state, verificationTrigger.action, verificationTrigger.at);
    if (event.type === 'adjustment.approved') {
      this.recomputeVerifications(state, 'adjustment_approved', event.occurredAt);
      state.requiredEvidence = new Set((payload.requiredEvidence ?? []) as string[]);
      if (state.status !== 'partially_paid' && state.status !== 'settled') state.status = 'ready_for_adjustment';
    }

    // A frozen adjustment that loses its evidence basis cannot keep the case ready for payment.
    // Partially paid cases are reopened so further payouts stop until the adjustment is recalculated.
    const activeAdjustment = state.conclusions.filter((c) => c.kind === 'adjustment' && c.status === 'active').at(-1);
    if (adjustmentJustInvalidated && (state.status === 'ready_for_adjustment' || state.status === 'partially_paid' || state.status === 'reopened')) {
      state.status = state.status === 'partially_paid' ? 'reopened' : 'investigating';
    } else if (verificationTrigger && !activeAdjustment && (state.status === 'ready_for_adjustment' || state.status === 'reopened')) state.status = 'investigating';

    state.audit.push({ sequence: event.sequence, eventId: event.id, type: event.type, occurredAt: event.occurredAt, actor: event.actor, summary: `${event.type} accepted` });
  }

  private normalizeRecord(record: EvidenceRecord): EvidenceRecord {
    // Events arriving through the generic events API may predate the lifecycle field.
    return record.state ? record : { ...record, state: 'active' };
  }

  private normalizeReview(payload: any, event: DomainEvent): EvidenceReview {
    if (payload.review) return { ...payload.review };
    // Backward compatibility with events persisted before reviews were separate records.
    const record = payload.evidence as EvidenceRecord;
    return {
      id: `review:${event.id}`,
      evidenceId: record.id,
      kind: record.kind,
      version: record.version,
      hash: record.hash,
      accepted: Boolean(record.accepted),
      reviewer: event.actor,
      reviewedAt: event.occurredAt,
      active: true,
    };
  }

  /**
   * Reopen verifications whose accepted binding changed, was withdrawn, or whose
   * decision flipped to rejected. Conclusions that bound the affected kinds are
   * marked invalidated with an explicit, auditable reason — never overwritten.
   */
  private invalidateConclusions(state: ClaimState, event: DomainEvent, action?: string): void {
    if (!action) return;
    const affected = new Set<string>();
    let reason: string;
    let toBinding: EvidenceBinding | undefined;

    if (action === 'evidence_replaced') {
      const incoming = (event.payload as any).evidence as EvidenceRecord;
      affected.add(incoming.kind);
      reason = `evidence replaced: ${incoming.kind} v${incoming.version} (${incoming.hash.slice(0, 12)}) supersedes the version this result was calculated from`;
      toBinding = bindingFor(incoming);
    } else if (action === 'evidence_withdrawn') {
      const withdrawn = (event.payload as any).evidence as EvidenceRecord;
      affected.add(withdrawn.kind);
      reason = `evidence withdrawn: ${withdrawn.kind} v${withdrawn.version} is no longer available for verification`;
    } else if (action === 'evidence_rejected') {
      const record = (event.payload as any).evidence as EvidenceRecord;
      affected.add(record.kind);
      reason = `evidence rejected: review refused ${record.kind} v${record.version} (${record.hash.slice(0, 12)})`;
    } else {
      return;
    }

    for (const conclusion of state.conclusions) {
      if (conclusion.status !== 'active') continue;
      const hit = conclusion.basis.filter((binding) => affected.has(binding.kind));
      if (!hit.length) continue;
      conclusion.status = 'invalidated';
      conclusion.invalidation = {
        invalidatedAt: event.occurredAt,
        triggerEventId: event.id,
        triggerType: event.type,
        reason,
        fromBindings: hit,
        toBinding: action === 'evidence_replaced' ? toBinding : undefined,
      };
    }
  }

  private appendConclusion(existing: InvestigationConclusion[], conclusion: InvestigationConclusion): InvestigationConclusion[] {
    // Frozen conclusions are append-only: a fresh calculation supersedes the
    // previous active one but leaves its payload and basis intact for audit.
    const prior = existing.filter((item) => item.kind === conclusion.kind && item.status === 'active');
    const superseded = existing.map((item) => prior.includes(item) ? { ...item, status: 'superseded' as const } : item);
    return [...superseded, conclusion];
  }

  private projectConclusions(state: ClaimState): void {
    // Statuses are immutable once they leave 'active'; project only the latest active result.
    const risk = state.conclusions.filter((c) => c.kind === 'risk' && c.status === 'active').at(-1);
    state.riskSignals = risk ? (risk.payload as any).signals : [];
    state.riskScore = risk ? (risk.payload as any).score : 0;
    const adjustment = state.conclusions.filter((c) => c.kind === 'adjustment' && c.status === 'active').at(-1);
    state.approvedMinor = adjustment ? (adjustment.payload as any).approvedMinor : 0;
    if (adjustment) state.requiredEvidence = new Set((adjustment.payload as any).requiredEvidence ?? []);
  }

  /**
   * Re-derive every verification condition from the current evidence state.
   * Conditions are keyed by evidence kind and tracked even before the required
   * set is known, so replace/withdraw/reject always have a condition to reopen.
   */
  private recomputeVerifications(state: ClaimState, action: VerificationHistoryEntry['reason'], at: string): void {
    const effective = new Map<string, EvidenceRecord>();
    for (const record of state.evidence) {
      const existing = effective.get(record.kind);
      if (!existing || record.version > existing.version) effective.set(record.kind, record);
    }
    const kinds = new Set<string>([...state.requiredEvidence, ...state.evidence.map((record) => record.kind)]);
    const byKind = new Map(state.verifications.map((condition) => [condition.kind, condition]));

    for (const kind of [...kinds].sort()) {
      const previous = byKind.get(kind);
      const head = effective.get(kind);
      const active = head && head.state === 'active' ? head : undefined;
      const review = active
        ? state.evidenceReviews
          .filter((candidate) => candidate.active && candidate.evidenceId === active.id && candidate.hash === active.hash)
          .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt))
          .at(-1)
        : undefined;

      let status: VerificationStatus;
      let binding: EvidenceBinding | undefined;
      let reviewId: string | undefined;
      if (active && review?.accepted) { status = 'satisfied'; binding = bindingFor(active); reviewId = review.id; }
      else if (active && review && !review.accepted) { status = 'rejected'; binding = bindingFor(active); reviewId = review.id; }
      else if (head?.state === 'withdrawn') { status = 'reopened'; }
      else { status = 'pending'; }
      // A satisfied condition whose binding is replaced or withdrawn reopens.
      if (status === 'pending' && previous?.status === 'satisfied' && (action === 'evidence_replaced' || action === 'evidence_withdrawn')) status = 'reopened';
      // A fresh rejection reopens a condition that had already been passed; a first-time rejection stays rejected.
      if (status === 'rejected' && previous?.status === 'satisfied') status = 'reopened';

      const changed = !previous || previous.status !== status || (previous.binding?.evidenceId !== binding?.evidenceId);
      const condition: VerificationCondition = previous ?? { kind, status, updatedAt: at, history: [] };
      if (changed) {
        condition.status = status;
        condition.binding = binding;
        condition.reviewId = reviewId;
        condition.updatedAt = at;
        // The initial pending state is the condition's birth, not a verifiable transition.
        if (previous || status !== 'pending') condition.history.push({ status, since: at, reason: action, binding, reviewId });
      }
      byKind.set(kind, condition);
    }
    state.verifications = [...byKind.values()].sort((a, b) => a.kind.localeCompare(b.kind));
  }
}
