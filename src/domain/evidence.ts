import { EvidenceBinding, EvidenceRecord, EvidenceReview } from './types';
import { newId, stableHash, iso } from './ids';

export class EvidenceLedger {
  add(input: { kind: string; source: string; content: unknown; receivedAt?: string; supersedes?: string }, current: EvidenceRecord[]): EvidenceRecord {
    const siblings = this.chain(current, input.kind);
    const latest = siblings.at(-1);
    if (input.supersedes) {
      if (!current.some((record) => record.id === input.supersedes)) throw new Error(`cannot supersede unknown evidence ${input.supersedes}`);
      if (!latest || latest.id !== input.supersedes) throw new Error(`evidence ${input.supersedes} is not the current version of kind ${input.kind}`);
    }
    return {
      id: newId('evidence'),
      kind: input.kind,
      source: input.source,
      hash: stableHash(input.content),
      version: (latest?.version ?? 0) + 1,
      receivedAt: iso(input.receivedAt),
      reviewed: false,
      supersedes: input.supersedes ?? latest?.id,
      state: 'active',
    };
  }

  review(id: string, accepted: boolean, current: EvidenceRecord[], reviewer: string, reviewedAt?: string): { record: EvidenceRecord; review: EvidenceReview } {
    const record = current.find((item) => item.id === id);
    if (!record) throw new Error(`unknown evidence ${id}`);
    if (record.state === 'withdrawn') throw new Error(`cannot review withdrawn evidence ${id}`);
    const latest = this.chain(current, record.kind).at(-1);
    if (!latest || latest.id !== record.id) {
      throw new Error(`evidence ${id} v${record.version} is not the current effective version of ${record.kind}; review v${latest?.version} instead`);
    }
    const at = iso(reviewedAt);
    const review: EvidenceReview = {
      id: newId('review'),
      evidenceId: record.id,
      kind: record.kind,
      version: record.version,
      hash: record.hash,
      accepted,
      reviewer,
      reviewedAt: at,
      active: true,
    };
    return { record: { ...record, reviewed: true, accepted }, review };
  }

  withdraw(id: string, current: EvidenceRecord[], at?: string): EvidenceRecord {
    const record = current.find((item) => item.id === id);
    if (!record) throw new Error(`unknown evidence ${id}`);
    if (record.state === 'withdrawn') throw new Error(`evidence ${id} is already withdrawn`);
    if (record.state === 'superseded') throw new Error(`cannot withdraw superseded evidence ${id}`);
    return { ...record, state: 'withdrawn', withdrawnAt: iso(at) };
  }

  chain(records: EvidenceRecord[], kind: string): EvidenceRecord[] {
    return records
      .filter((record) => record.kind === kind)
      .sort((left, right) => left.version - right.version);
  }

  currentByKind(records: EvidenceRecord[]): Map<string, EvidenceRecord> {
    const map = new Map<string, EvidenceRecord>();
    for (const record of records) {
      const existing = map.get(record.kind);
      if (!existing || record.version > existing.version) map.set(record.kind, record);
    }
    return map;
  }
}

/**
 * Latest *effective* record of each kind. A kind drops out entirely when its
 * current version is withdrawn, so consumers cannot reason from stale bytes.
 */
export function effectiveEvidence(records: EvidenceRecord[]): Map<string, EvidenceRecord> {
  const map = new Map<string, EvidenceRecord>();
  for (const record of records) {
    const existing = map.get(record.kind);
    if (!existing || record.version > existing.version) map.set(record.kind, record);
  }
  for (const [kind, record] of map) {
    if (record.state !== 'active') map.delete(kind);
  }
  return map;
}

/**
 * Accepted-evidence snapshot that a derived conclusion must bind to. Only the
 * newest review of the current active version counts: an acceptance on an old
 * hash can never justify a new conclusion.
 */
export function acceptedBindings(records: EvidenceRecord[], reviews: EvidenceReview[]): EvidenceBinding[] {
  const effective = effectiveEvidence(records);
  const bindings: EvidenceBinding[] = [];
  for (const [kind, record] of effective) {
    const activeReview = reviews
      .filter((review) => review.active && review.kind === kind && review.evidenceId === record.id && review.hash === record.hash && review.accepted)
      .sort((a, b) => a.reviewedAt.localeCompare(b.reviewedAt))
      .at(-1);
    if (activeReview) bindings.push(bindingFor(record));
  }
  return bindings.sort((a, b) => a.kind.localeCompare(b.kind));
}

export function bindingFor(record: EvidenceRecord): EvidenceBinding {
  return { kind: record.kind, evidenceId: record.id, version: record.version, hash: record.hash };
}
