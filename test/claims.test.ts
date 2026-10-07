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

test('replaced evidence invalidates stale conclusions and reopens verification conditions', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'mobile', participants: [{ kind: 'vehicle', id: 'car-9' }], loss: { currency: 'CNY', gross: 18000 } }, 'test');
  let state = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'v1' } }, 'test');
  const photoV1 = state.evidence.find((e) => e.kind === 'loss-photo')!;
  state = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'shop', content: { amount: 18000 } }, 'test');
  const estimateV1 = state.evidence.find((e) => e.kind === 'repair-estimate')!;
  app.claims.reviewEvidence(claim.id, photoV1.id, true, 'adjuster');
  app.claims.reviewEvidence(claim.id, estimateV1.id, true, 'adjuster');
  state = app.claims.adjust(claim.id, 'adjuster');
  assert.equal(state.status, 'ready_for_adjustment');
  assert.ok(state.approvedMinor > 0);
  const adjustmentV1 = state.conclusions.find((c) => c.kind === 'adjustment')!;
  assert.equal(adjustmentV1.status, 'active');
  assert.ok(adjustmentV1.basis.some((b) => b.evidenceId === photoV1.id && b.hash === photoV1.hash && b.version === 1));

  // 补充材料被重新上传：v2 自动取代 v1，旧通过结论失效，核验条件重新打开
  state = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'mobile', content: { image: 'v2' } }, 'test');
  const photoV2 = state.evidence.find((e) => e.kind === 'loss-photo' && e.version === 2)!;
  assert.equal(photoV2.supersedes, photoV1.id);
  assert.equal(state.evidence.find((e) => e.id === photoV1.id)!.supersededBy, photoV2.id);
  assert.equal(state.status, 'awaiting_documents');
  assert.ok(state.pendingDocuments.includes('loss-photo'));
  assert.equal(state.approvedMinor, 0);
  const invalidated = state.conclusions.find((c) => c.id === adjustmentV1.id)!;
  assert.equal(invalidated.status, 'invalidated');
  assert.match(invalidated.invalidatedReason!, /superseded by/);
  const reviewV1 = state.reviews.find((r) => r.evidenceId === photoV1.id)!;
  assert.equal(reviewV1.status, 'invalidated');
  assert.match(reviewV1.invalidatedReason!, /superseded by/);

  // 旧版本不能再审核，理算不再依据旧证据状态
  assert.throws(() => app.claims.reviewEvidence(claim.id, photoV1.id, true, 'adjuster'), /not the current effective version/);
  assert.throws(() => app.payments.settle(claim.id, { amount: 1, currency: 'CNY', sourceId: 'p-x' }, 'pay'), /exceeds approved/);

  // 审核结论必须引用当前有效材料及其哈希
  state = app.claims.reviewEvidence(claim.id, photoV2.id, true, 'adjuster');
  const reviewV2 = state.reviews.find((r) => r.evidenceId === photoV2.id)!;
  assert.equal(reviewV2.status, 'active');
  assert.equal(reviewV2.evidenceVersion, 2);
  assert.equal(reviewV2.evidenceHash, photoV2.hash);
  assert.equal(state.status, 'ready_for_adjustment');

  // 重新计算生成新的可审计结论，旧结论保留为 invalidated 而非被覆盖
  state = app.claims.adjust(claim.id, 'adjuster');
  const adjustments = state.conclusions.filter((c) => c.kind === 'adjustment');
  assert.equal(adjustments.length, 2);
  assert.equal(adjustments[0].status, 'invalidated');
  assert.equal(adjustments[1].status, 'active');
  assert.ok(adjustments[1].sequence > adjustments[0].sequence);
  assert.ok(state.approvedMinor > 0);

  // 可以明确说明哪些旧结果因材料版本变化而失效
  const view = app.claims.conclusions(claim.id);
  assert.equal(view.active.length, 1);
  assert.equal(view.invalidated.length, 1);
  assert.match(view.invalidated[0].invalidatedReason!, /loss-photo.*superseded by/);

  // 事件重放得到相同的失效轨迹
  const replayed = app.replay.execute(claim.id).state;
  assert.deepEqual(replayed.conclusions, state.conclusions);
  assert.deepEqual(replayed.reviews, state.reviews);
});

test('withdrawn and rejected evidence reopens conditions and invalidates dependent conclusions', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent', participants: [], loss: { currency: 'CNY', gross: 18000 } }, 'test');
  let state = app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: 'a' }, 'test');
  const photo = state.evidence.find((e) => e.kind === 'loss-photo')!;
  state = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'shop', content: 'b' }, 'test');
  const estimate = state.evidence.find((e) => e.kind === 'repair-estimate')!;
  app.claims.reviewEvidence(claim.id, photo.id, true, 'adjuster');
  app.claims.reviewEvidence(claim.id, estimate.id, true, 'adjuster');
  state = app.claims.adjust(claim.id, 'adjuster');
  assert.equal(state.status, 'ready_for_adjustment');

  // 撤回当前有效版本 → 条件重开、依赖结论失效
  state = app.claims.withdrawEvidence(claim.id, estimate.id, 'adjuster', undefined, 'customer recalled the estimate');
  assert.equal(state.status, 'awaiting_documents');
  assert.ok(state.pendingDocuments.includes('repair-estimate'));
  assert.equal(state.approvedMinor, 0);
  const firstAdjustment = state.conclusions.find((c) => c.kind === 'adjustment')!;
  assert.equal(firstAdjustment.status, 'invalidated');
  assert.match(firstAdjustment.invalidatedReason!, /withdrawn/);
  assert.throws(() => app.claims.withdrawEvidence(claim.id, estimate.id, 'adjuster'), /already withdrawn/);
  assert.throws(() => app.claims.reviewEvidence(claim.id, estimate.id, true, 'adjuster'), /withdrawn/);

  // 撤回后重新上传开启新链条，审核通过后条件关闭
  state = app.claims.addEvidence(claim.id, { kind: 'repair-estimate', source: 'shop', content: 'b2' }, 'test');
  const estimateV2 = state.evidence.find((e) => e.kind === 'repair-estimate' && !e.withdrawn)!;
  assert.equal(estimateV2.version, 2);
  assert.equal(estimateV2.supersedes, undefined);
  state = app.claims.reviewEvidence(claim.id, estimateV2.id, true, 'adjuster');
  assert.equal(state.status, 'ready_for_adjustment');
  state = app.claims.adjust(claim.id, 'adjuster');
  assert.ok(state.approvedMinor > 0);

  // 拒绝当前有效版本 → 条件重开、依赖结论失效，旧审核结论被取代而非覆盖
  state = app.claims.reviewEvidence(claim.id, estimateV2.id, false, 'reviewer');
  assert.equal(state.status, 'awaiting_documents');
  assert.ok(state.pendingDocuments.includes('repair-estimate'));
  assert.equal(state.approvedMinor, 0);
  const adjustments = state.conclusions.filter((c) => c.kind === 'adjustment');
  assert.equal(adjustments.length, 2);
  assert.equal(adjustments[1].status, 'invalidated');
  assert.match(adjustments[1].invalidatedReason!, /rejected/);
  const estimateReviews = state.reviews.filter((r) => r.evidenceId === estimateV2.id);
  assert.deepEqual(estimateReviews.map((r) => r.decision), ['accepted', 'rejected']);
  assert.equal(estimateReviews[0].status, 'superseded');
  assert.equal(estimateReviews[1].status, 'active');

  // 重新接受生成第三条审核结论，条件再次关闭
  state = app.claims.reviewEvidence(claim.id, estimateV2.id, true, 'reviewer');
  assert.equal(state.status, 'ready_for_adjustment');
  assert.equal(state.reviews.filter((r) => r.evidenceId === estimateV2.id).length, 3);
});

test('risk reassessment appends auditable conclusions instead of overwriting them', () => {
  const app = buildApp();
  const claim = app.claims.create({ policyId: 'P-100', lossAt: '2026-08-01T08:00:00Z', reportedAt: '2026-08-01T09:00:00Z', channel: 'agent', participants: [{ kind: 'vehicle', id: 'car-10' }], loss: { currency: 'CNY', gross: 18000 } }, 'test');
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: 'photo' }, 'test');
  const first = app.risks.assess(claim.id, 'risk');
  assert.equal(first.conclusions.length, 1);
  assert.equal(first.conclusions[0].basis.length, 1);
  assert.ok(first.conclusions[0].basisHash.length > 0);
  // 幂等：材料未变化时重复评估不产生新结论
  const again = app.risks.assess(claim.id, 'risk');
  assert.equal(again.conclusions.length, 1);
  // 材料版本变化使旧风险结论失效，重新评估生成新结论
  app.claims.addEvidence(claim.id, { kind: 'loss-photo', source: 'agent', content: 'photo-v2' }, 'test');
  const third = app.risks.assess(claim.id, 'risk');
  const riskConclusions = third.conclusions.filter((c) => c.kind === 'risk');
  assert.equal(riskConclusions.length, 2);
  assert.equal(riskConclusions[0].status, 'invalidated');
  assert.match(riskConclusions[0].invalidatedReason!, /superseded by/);
  assert.equal(riskConclusions[1].status, 'active');
  const v2 = third.evidence.find((e) => e.version === 2)!;
  assert.equal(third.evidence.find((e) => e.version === 1)!.supersededBy, v2.id);
  assert.ok(riskConclusions[1].basis.some((b) => b.evidenceId === v2.id && b.hash === v2.hash));
});
