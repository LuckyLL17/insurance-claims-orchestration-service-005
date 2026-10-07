import { EventStore } from './event-store';
import { EvidenceLedger, effectiveEvidence, evidenceBasis } from '../domain/evidence';
import { PolicyCatalog } from '../domain/policy';
import { RuleEngine } from '../domain/rules';
import { AdjustmentResult, ClaimReportedPayload, ClaimState, ConclusionRecord, DomainEvent, EvidenceRecord, ReviewConclusion, RiskResult } from '../domain/types';
import { newId, iso, stableHash } from '../domain/ids';

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
    const claim = this.get(id); const record = this.evidence.add(input, claim.evidence); return this.addEvent(id, 'evidence.added', { evidence: record }, actor, key, input.receivedAt);
  }

  reviewEvidence(id: string, evidenceId: string, accepted: boolean, actor: string, key?: string): ClaimState {
    const claim = this.get(id); const { record, conclusion } = this.evidence.review(evidenceId, accepted, claim.evidence, actor); return this.addEvent(id, 'evidence.reviewed', { evidence: record, conclusion }, actor, key);
  }

  withdrawEvidence(id: string, evidenceId: string, actor: string, key?: string, reason?: string): ClaimState {
    const claim = this.get(id); const record = this.evidence.withdraw(evidenceId, claim.evidence); return this.addEvent(id, 'evidence.withdrawn', { evidence: record, reason }, actor, key);
  }

  adjust(id: string, actor: string, key?: string): ClaimState {
    const claim = this.get(id);
    if (!claim.ruleSnapshot) throw new Error(`claim ${id} has no rule snapshot`);
    const decision = this.rules.evaluate(claim, claim.ruleSnapshot);
    if (decision.reasons.length) throw new Error(`adjustment blocked: ${decision.reasons.join('; ')}`);
    const basis = evidenceBasis(claim.evidence);
    const conclusion: ConclusionRecord = {
      id: newId('conclusion'),
      kind: 'adjustment',
      sequence: claim.conclusions.length + 1,
      createdAt: iso(),
      actor,
      basis,
      basisHash: stableHash(basis),
      result: { approvedMinor: decision.approvedMinor, requiredEvidence: decision.requiredEvidence, reasons: decision.reasons },
      status: 'active',
    };
    return this.addEvent(id, 'adjustment.approved', { ...decision, conclusion }, actor, key);
  }

  conclusions(id: string) {
    const state = this.get(id);
    return {
      claimId: id,
      active: state.conclusions.filter((item) => item.status === 'active'),
      superseded: state.conclusions.filter((item) => item.status === 'superseded'),
      invalidated: state.conclusions
        .filter((item) => item.status === 'invalidated')
        .map((item) => ({ id: item.id, kind: item.kind, sequence: item.sequence, invalidatedReason: item.invalidatedReason, basis: item.basis })),
      reviews: state.reviews,
    };
  }

  get(id: string): ClaimState { return this.replay(id, this.events.list(id)); }
  replay(id: string, events: DomainEvent[]): ClaimState {
    const state = this.empty(id);
    for (const event of events.sort((a, b) => a.sequence - b.sequence)) this.apply(state, event);
    if (!state.policy) throw new Error(`claim ${id} has no policy snapshot`);
    return state;
  }

  private empty(id: string): ClaimState { return { id, policyId: '', status: 'reported', lossAt: '', reportedAt: '', channel: '', participants: [], loss: { currency: 'CNY', gross: 0 }, evidence: [], reviews: [], conclusions: [], requiredEvidence: new Set(), completedSurveys: [], pendingDocuments: [], riskSignals: [], riskScore: 0, payments: [], approvedMinor: 0, audit: [], processedEventIds: new Set(), version: 0 }; }
  private assertExists(id: string): void { if (this.events.list(id).length === 0) throw new Error(`unknown claim ${id}`); }

  private isKindSatisfied(state: ClaimState, kind: string): boolean {
    return effectiveEvidence(state.evidence).some((record) => record.kind === kind && record.reviewed && record.accepted);
  }

  private note(state: ClaimState, event: DomainEvent, summary: string): void {
    state.audit.push({ sequence: event.sequence, eventId: event.id, type: event.type, occurredAt: event.occurredAt, actor: event.actor, summary });
  }

  private appendConclusion(state: ClaimState, conclusion: ConclusionRecord, event: DomainEvent): void {
    for (const prior of state.conclusions) {
      if (prior.kind === conclusion.kind && prior.status === 'active') {
        prior.status = 'superseded';
        prior.supersededBy = conclusion.id;
        this.note(state, event, `conclusion ${prior.id} (${prior.kind}#${prior.sequence}) superseded by ${conclusion.id}`);
      }
    }
    state.conclusions.push(conclusion);
  }

  private invalidateReviews(state: ClaimState, evidenceId: string, reason: string, event: DomainEvent): void {
    for (const review of state.reviews) {
      if (review.evidenceId === evidenceId && review.status === 'active') {
        review.status = 'invalidated';
        review.invalidatedReason = reason;
        this.note(state, event, `review ${review.id} (${review.kind} v${review.evidenceVersion} hash ${review.evidenceHash}) invalidated: ${reason}`);
      }
    }
  }

  private invalidateConclusions(state: ClaimState, evidenceId: string, reason: string, event: DomainEvent): void {
    let changed = false;
    for (const conclusion of state.conclusions) {
      if (conclusion.status === 'active' && conclusion.basis.some((item) => item.evidenceId === evidenceId)) {
        conclusion.status = 'invalidated';
        conclusion.invalidatedReason = reason;
        changed = true;
        this.note(state, event, `conclusion ${conclusion.id} (${conclusion.kind}#${conclusion.sequence}) invalidated: ${reason}`);
      }
    }
    if (changed) this.refreshDerived(state);
  }

  private refreshDerived(state: ClaimState): void {
    const activeAdjustment = [...state.conclusions].reverse().find((item) => item.kind === 'adjustment' && item.status === 'active');
    state.approvedMinor = activeAdjustment ? (activeAdjustment.result as AdjustmentResult).approvedMinor : 0;
    const activeRisk = [...state.conclusions].reverse().find((item) => item.kind === 'risk' && item.status === 'active');
    state.riskScore = activeRisk ? (activeRisk.result as RiskResult).score : 0;
    state.riskSignals = activeRisk ? (activeRisk.result as RiskResult).signals : [];
  }

  private reopenCondition(state: ClaimState, kind: string, cause: string, event: DomainEvent): void {
    if (!state.requiredEvidence.has(kind)) return;
    if (!state.pendingDocuments.includes(kind)) {
      state.pendingDocuments = [...state.pendingDocuments, kind];
      this.note(state, event, `verification condition '${kind}' reopened: ${cause}`);
    }
    if (state.status === 'ready_for_adjustment' || state.status === 'partially_paid') {
      state.status = 'awaiting_documents';
      this.note(state, event, `claim status reopened to awaiting_documents: ${cause}`);
    }
  }

  private closeCondition(state: ClaimState, kind: string, event: DomainEvent): void {
    if (!state.pendingDocuments.includes(kind)) return;
    state.pendingDocuments = state.pendingDocuments.filter((pending) => pending !== kind);
    this.note(state, event, `verification condition '${kind}' satisfied by current accepted evidence`);
    const allSatisfied = [...state.requiredEvidence].every((required) => this.isKindSatisfied(state, required));
    if (!state.pendingDocuments.length && allSatisfied && state.status === 'awaiting_documents') state.status = 'ready_for_adjustment';
  }

  private apply(state: ClaimState, event: DomainEvent): void {
    if (state.processedEventIds.has(event.id)) return; state.processedEventIds.add(event.id); state.version = event.sequence;
    const payload = event.payload as any;
    if (event.type === 'claim.reported') { state.policyId = payload.policyId; state.lossAt = payload.lossAt; state.reportedAt = payload.reportedAt; state.channel = payload.channel; state.participants = payload.participants; state.loss = payload.loss; state.status = 'reported'; }
    if (event.type === 'policy.snapshot.created') { state.policy = payload.policy; state.ruleSnapshot = payload.ruleSnapshot; }
    if (event.type === 'evidence.added') {
      const record = payload.evidence as EvidenceRecord;
      if (record.supersedes) {
        state.evidence = state.evidence.map((item) => (item.id === record.supersedes ? { ...item, supersededBy: record.id } : item));
        const reason = `evidence ${record.supersedes} (${record.kind}) superseded by ${record.id} (version ${record.version}, hash ${record.hash})`;
        this.invalidateReviews(state, record.supersedes, reason, event);
        this.invalidateConclusions(state, record.supersedes, reason, event);
        this.reopenCondition(state, record.kind, `material '${record.kind}' replaced by version ${record.version}`, event);
      }
      state.evidence = [...state.evidence.filter((item) => item.id !== record.id), { ...record }];
      state.status = state.status === 'reported' ? 'investigating' : state.status;
    }
    if (event.type === 'evidence.reviewed') {
      const record = payload.evidence as EvidenceRecord;
      state.evidence = state.evidence.map((item) => (item.id === record.id ? { ...record } : item));
      const conclusion: ReviewConclusion = payload.conclusion
        ? { ...payload.conclusion }
        : { id: `review:${event.id}`, evidenceId: record.id, kind: record.kind, evidenceVersion: record.version, evidenceHash: record.hash, decision: record.accepted ? 'accepted' : 'rejected', createdAt: event.occurredAt, actor: event.actor, status: 'active' };
      for (const prior of state.reviews) {
        if (prior.evidenceId === conclusion.evidenceId && prior.status === 'active') {
          prior.status = 'superseded';
          prior.supersededBy = conclusion.id;
          this.note(state, event, `review ${prior.id} superseded by ${conclusion.id}`);
        }
      }
      state.reviews.push(conclusion);
      if (conclusion.decision === 'rejected') {
        this.invalidateConclusions(state, record.id, `evidence ${record.id} (${record.kind} v${record.version}) rejected`, event);
        this.reopenCondition(state, record.kind, `material '${record.kind}' rejected`, event);
      } else {
        this.closeCondition(state, record.kind, event);
      }
    }
    if (event.type === 'evidence.withdrawn') {
      const record = payload.evidence as EvidenceRecord;
      state.evidence = state.evidence.map((item) => (item.id === record.id ? { ...record } : item));
      const reason = `evidence ${record.id} (${record.kind} v${record.version}) withdrawn${payload.reason ? `: ${payload.reason}` : ''}`;
      this.invalidateReviews(state, record.id, reason, event);
      this.invalidateConclusions(state, record.id, reason, event);
      this.reopenCondition(state, record.kind, `material '${record.kind}' withdrawn`, event);
    }
    if (event.type === 'documents.requested') { state.pendingDocuments = [...new Set([...(state.pendingDocuments), ...(payload.kinds ?? [])])]; state.status = 'awaiting_documents'; }
    if (event.type === 'documents.received') {
      state.pendingDocuments = state.pendingDocuments.filter((kind) => !(payload.kinds ?? []).includes(kind));
      const allSatisfied = [...state.requiredEvidence].every((required) => this.isKindSatisfied(state, required));
      if (!state.pendingDocuments.length && allSatisfied) state.status = 'ready_for_adjustment';
    }
    if (event.type === 'survey.completed') { state.completedSurveys = [...new Set([...state.completedSurveys, payload.taskId])]; }
    if (event.type === 'risk.assessed' || event.type === 'adjustment.approved') {
      const kind = event.type === 'risk.assessed' ? 'risk' : 'adjustment';
      const conclusion: ConclusionRecord = payload.conclusion
        ? { ...payload.conclusion, basis: (payload.conclusion.basis ?? []).map((item: any) => ({ ...item })) }
        : {
            id: `conclusion:${event.id}`,
            kind,
            sequence: state.conclusions.length + 1,
            createdAt: event.occurredAt,
            actor: event.actor,
            basis: [],
            basisHash: '',
            result: kind === 'risk'
              ? { score: payload.score ?? 0, signals: payload.signals ?? [] }
              : { approvedMinor: payload.approvedMinor ?? 0, requiredEvidence: payload.requiredEvidence ?? [], reasons: payload.reasons ?? [] },
            status: 'active',
          };
      this.appendConclusion(state, conclusion, event);
      if (kind === 'risk') {
        const result = conclusion.result as RiskResult;
        state.riskSignals = result.signals; state.riskScore = result.score;
      } else {
        const result = conclusion.result as AdjustmentResult;
        state.approvedMinor = result.approvedMinor;
        state.requiredEvidence = new Set(result.requiredEvidence);
        const open = result.requiredEvidence.filter((kind2) => !this.isKindSatisfied(state, kind2));
        state.pendingDocuments = [...new Set([...state.pendingDocuments, ...open])];
        state.status = state.pendingDocuments.length ? 'awaiting_documents' : 'ready_for_adjustment';
      }
    }
    if (event.type === 'payment.settled' || event.type === 'payment.reversed') { state.payments = [...state.payments, payload.payment]; state.status = payload.payment.kind === 'reversal' ? 'reopened' : 'partially_paid'; }
    if (event.type === 'claim.reopened') state.status = 'reopened';
    if (event.type === 'claim.rejected') state.status = 'rejected';
    state.audit.push({ sequence: event.sequence, eventId: event.id, type: event.type, occurredAt: event.occurredAt, actor: event.actor, summary: `${event.type} accepted` });
  }
}
