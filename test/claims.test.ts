import test from 'node:test';
import assert from 'node:assert/strict';
import { buildApp } from '../src/index';

test('creates a claim with a historical policy snapshot and replays it', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'mobile', participants: [{ kind: 'vehicle', id: 'car-1' }], loss: { currency: 'CNY', gross: 18000 } }, 'test', 'claim-key');
  assert.equal(claim.policy?.version, 2);
  const evidence = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'a' } }, 'test');
  const reviewed = app.claims.reviewEvidence(evidence.id, evidence.evidence[0].id, true, 'adjuster');
  assert.equal(reviewed.evidence[0].accepted, true);
  assert.equal(app.replay.execute(claim.id).state.version, reviewed.version);
});

test('prevents payment over approved amount and accepts idempotent risk assessment', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent', participants: [{ kind: 'vehicle', id: 'car-2' }, { kind: 'repair_shop', id: 'shop-1' }], loss: { currency: 'CNY', gross: 18000 } }, 'test');
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: 'photo' }, 'test');
  const assessed = app.risks.assess(claim.id, 'risk');
  assert.equal(assessed.riskScore, 0);
  assert.throws(() => app.payments.settle(claim.id, { amount: 1, currency: 'CNY', sourceId: 'p-1' }, 'pay'), /exceeds approved/);
});

test('rejects stale task submissions after lease version changes', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent', participants: [], loss: { currency: 'CNY', gross: 3000 } }, 'test');
  const task = app.tasks.create(claim.id, 'survey'); const lease = app.tasks.lease(claim.id, task.id, 'adjuster-a', 60_000);
  assert.throws(() => app.tasks.submit(claim.id, task.id, 'adjuster-a', lease.version - 1, {}, 'adjuster-a'), /stale/);
});

test('binds review conclusions to the current effective material version and hash', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'mobile', participants: [], loss: { currency: 'CNY', gross: 18000 } }, 'test');
  const v1 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'a' } }, 'test');
  const first = v1.evidence.find((e) => e.kind === 'loss-photo')!;
  const accepted = app.claims.reviewEvidence(claim.id, first.id, true, 'adjuster-1');
  const review = accepted.evidenceReviews.filter((r) => r.evidenceId === first.id).at(-1)!;
  assert.equal(review.version, 1);
  assert.equal(review.hash, first.hash);

  // Re-uploaded supplementary material creates v2 and closes v1.
  const v2 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'b' } }, 'test');
  const second = v2.evidence.find((e) => e.version === 2)!;
  assert.equal(second.state, 'active');
  assert.equal(v2.evidence.find((e) => e.id === first.id)!.state, 'superseded');
  assert.equal(v2.evidence.find((e) => e.id === first.id)!.supersededBy, second.id);

  // A review cannot be attached to the stale version anymore.
  assert.throws(() => app.claims.reviewEvidence(claim.id, first.id, true, 'adjuster-2'), /not the current effective version/);

  // The old acceptance remains on record but is no longer active; the verification reopens.
  const reopened = app.claims.get(claim.id);
  assert.equal(reopened.evidenceReviews.find((r) => r.evidenceId === first.id)!.active, false);
  const condition = reopened.verifications.find((c) => c.kind === 'loss-photo')!;
  assert.equal(condition.status, 'reopened');
  assert.equal(condition.binding, undefined);
  const transitioned = condition.history.map((entry) => entry.status);
  assert.deepEqual(transitioned, ['satisfied', 'reopened']);
  assert.equal(condition.history.at(-1)!.reason, 'evidence_replaced');

  // Accepting v2 binds the conclusion to v2's id and hash.
  const reReviewed = app.claims.reviewEvidence(claim.id, second.id, true, 'adjuster-2');
  const fresh = reReviewed.verifications.find((c) => c.kind === 'loss-photo')!;
  assert.equal(fresh.status, 'satisfied');
  assert.equal(fresh.binding!.evidenceId, second.id);
  assert.equal(fresh.binding!.version, 2);
  assert.equal(fresh.binding!.hash, second.hash);
});

test('rejection and withdrawal reopen verification conditions', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent', participants: [], loss: { currency: 'CNY', gross: 18000 } }, 'test');
  const added = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'agent', content: { amount: 18000 } }, 'test');
  const record = added.evidence[0];
  app.claims.reviewEvidence(claim.id, record.id, true, 'adjuster');
  const rejected = app.claims.reviewEvidence(claim.id, record.id, false, 'adjuster');
  const byReject = rejected.verifications.find((c) => c.kind === 'repair-estimate')!;
  assert.equal(byReject.status, 'reopened');
  assert.equal(byReject.history.at(-1)!.reason, 'evidence_rejected');
  // prior acceptance is superseded by the rejection, never overwritten
  assert.equal(rejected.evidenceReviews.length, 2);
  assert.equal(rejected.evidenceReviews[0].accepted, true);
  assert.equal(rejected.evidenceReviews[0].active, false);
  assert.equal(rejected.evidenceReviews[1].accepted, false);

  const acceptedAgain = app.claims.reviewEvidence(claim.id, record.id, true, 'adjuster');
  const withdrawn = app.claims.withdrawEvidence(claim.id, record.id, 'investigator');
  assert.equal(withdrawn.evidence[0].state, 'withdrawn');
  const byWithdraw = withdrawn.verifications.find((c) => c.kind === 'repair-estimate')!;
  assert.equal(byWithdraw.status, 'reopened');
  assert.equal(byWithdraw.history.at(-1)!.reason, 'evidence_withdrawn');
  assert.throws(() => app.claims.withdrawEvidence(claim.id, record.id, 'investigator'), /already withdrawn/);
});

test('frozen adjustment and risk conclusions are append-only and invalidated by evidence changes', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent', participants: [{ kind: 'repair_shop', id: 'shop-1' }], loss: { currency: 'CNY', gross: 18000 } }, 'test');
  const photoV1 = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: 'photo-v1' }, 'test');
  const estimateV1 = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'shop-1', content: 'estimate-v1' }, 'test');
  app.claims.reviewEvidence(claim.id, photoV1.evidence.find((e) => e.kind === 'loss-photo')!.id, true, 'adjuster');
  app.claims.reviewEvidence(claim.id, estimateV1.evidence.find((e) => e.kind === 'repair-estimate')!.id, true, 'adjuster');

  app.risks.assess(claim.id, 'risk');
  const approved = app.claims.approveAdjustment(claim.id, 'adjuster');
  assert.ok(approved.approvedMinor > 0);
  const conclusionsBefore = approved.conclusions;
  assert.equal(conclusionsBefore.filter((c) => c.status === 'active').length, 2);

  // Payment works against the frozen, still-active conclusion.
  app.payments.settle(claim.id, { amount: 1, currency: 'CNY', sourceId: 'p-1' }, 'pay');

  // Re-upload one piece of material: both frozen conclusions must be invalidated, not overwritten.
  const replaced = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: 'photo-v2' }, 'test');
  for (const conclusion of replaced.conclusions) {
    assert.equal(conclusion.status, 'invalidated');
    assert.equal(conclusion.invalidation!.reason.includes('evidence replaced'), true);
    assert.equal(conclusion.invalidation!.fromBindings.some((binding) => binding.kind === 'loss-photo'), true);
    assert.equal(conclusion.invalidation!.toBinding!.version, 2);
    assert.equal(conclusion.invalidation!.triggerType, 'evidence.added');
  }
  assert.equal(replaced.approvedMinor, 0);
  assert.equal(replaced.status, 'reopened');

  // Adjustment service now refuses to use the stale evidence state.
  assert.throws(() => app.payments.settle(claim.id, { amount: 1, currency: 'CNY', sourceId: 'p-2' }, 'pay'), /older evidence version/);

  // Review the new material and recalculate: a brand new conclusion is produced; the old one stays auditable.
  const photoV2 = replaced.evidence.find((e) => e.kind === 'loss-photo' && e.version === 2)!;
  app.claims.reviewEvidence(claim.id, photoV2.id, true, 'adjuster');
  const recalculated = app.claims.approveAdjustment(claim.id, 'adjuster-2');
  const adjustments = recalculated.conclusions.filter((c) => c.kind === 'adjustment');
  assert.equal(adjustments.length, 2);
  assert.equal(adjustments[0].status, 'invalidated');
  assert.equal((adjustments[0].payload as { approvedMinor: number }).approvedMinor, (adjustments[1].payload as { approvedMinor: number }).approvedMinor);
  assert.equal(adjustments[1].status, 'active');
  assert.equal(adjustments[1].basis.find((b) => b.kind === 'loss-photo')!.version, 2);
  assert.notEqual(adjustments[0].id, adjustments[1].id);

  // Event replay reconstructs the same conclusion chain and invalidation explanations.
  const replayed = app.replay.execute(claim.id).state;
  assert.deepEqual(replayed.conclusions.map((c) => ({ id: c.id, status: c.status, kind: c.kind })), recalculated.conclusions.map((c) => ({ id: c.id, status: c.status, kind: c.kind })));
  assert.equal(replayed.verifications.find((c) => c.kind === 'loss-photo')!.status, 'satisfied');

  // A second risk run appends a fresh risk conclusion and only supersedes the prior active one.
  app.risks.assess(claim.id, 'risk-2');
  const after = app.claims.get(claim.id);
  const riskStatuses = after.conclusions.filter((c) => c.kind === 'risk').map((c) => c.status);
  assert.deepEqual(riskStatuses, ['invalidated', 'active']);
});

