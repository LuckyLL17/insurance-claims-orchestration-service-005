import { EvidenceBasisItem, EvidenceRecord, ReviewConclusion } from './types';
import { newId, stableHash, iso } from './ids';

/**
 * Effective evidence per kind: the head of each version chain, i.e. records
 * that have not been superseded by a newer upload and not withdrawn.
 * Superseded or withdrawn records keep their history but no longer count
 * as the current material for reviews, rules or derived conclusions.
 */
export function effectiveEvidence(records: EvidenceRecord[]): EvidenceRecord[] {
  const byKind = new Map<string, EvidenceRecord>();
  for (const record of records) {
    if (record.withdrawn || record.supersededBy) continue;
    const existing = byKind.get(record.kind);
    if (!existing || record.version > existing.version) byKind.set(record.kind, record);
  }
  return [...byKind.values()];
}

export function evidenceBasis(records: EvidenceRecord[]): EvidenceBasisItem[] {
  return effectiveEvidence(records)
    .map((record) => ({ evidenceId: record.id, kind: record.kind, version: record.version, hash: record.hash }))
    .sort((left, right) => left.kind.localeCompare(right.kind) || left.evidenceId.localeCompare(right.evidenceId));
}

export class EvidenceLedger {
  add(input: { kind: string; source: string; content: unknown; receivedAt?: string; supersedes?: string }, current: EvidenceRecord[]): EvidenceRecord {
    const effective = effectiveEvidence(current);
    const head = effective.find((record) => record.kind === input.kind);
    const supersedes = input.supersedes ?? head?.id;
    const prior = supersedes ? current.find((record) => record.id === supersedes) : undefined;
    if (supersedes && !prior) throw new Error(`cannot supersede unknown evidence ${supersedes}`);
    if (prior && prior.id !== head?.id) throw new Error(`evidence ${supersedes} is not the current effective version for kind ${input.kind}; supersede ${head?.id ?? 'none'} instead`);
    const version = current.filter((record) => record.kind === input.kind).reduce((max, record) => Math.max(max, record.version), 0) + 1;
    return { id: newId('evidence'), kind: input.kind, source: input.source, hash: stableHash(input.content), version, receivedAt: iso(input.receivedAt), reviewed: false, supersedes };
  }

  review(id: string, accepted: boolean, current: EvidenceRecord[], actor: string): { record: EvidenceRecord; conclusion: ReviewConclusion } {
    const record = current.find((item) => item.id === id);
    if (!record) throw new Error(`unknown evidence ${id}`);
    if (record.withdrawn) throw new Error(`evidence ${id} (kind ${record.kind}) was withdrawn and cannot be reviewed`);
    const head = effectiveEvidence(current).find((item) => item.kind === record.kind);
    if (!head || head.id !== record.id) {
      throw new Error(`evidence ${id} (kind ${record.kind}, version ${record.version}) is not the current effective version; review ${head ? `${head.id} (version ${head.version}, hash ${head.hash})` : 'a newly uploaded version'} instead`);
    }
    const reviewed = { ...record, reviewed: true, accepted };
    const conclusion: ReviewConclusion = {
      id: newId('review'),
      evidenceId: record.id,
      kind: record.kind,
      evidenceVersion: record.version,
      evidenceHash: record.hash,
      decision: accepted ? 'accepted' : 'rejected',
      createdAt: iso(),
      actor,
      status: 'active',
    };
    return { record: reviewed, conclusion };
  }

  withdraw(id: string, current: EvidenceRecord[]): EvidenceRecord {
    const record = current.find((item) => item.id === id);
    if (!record) throw new Error(`unknown evidence ${id}`);
    if (record.withdrawn) throw new Error(`evidence ${id} is already withdrawn`);
    const head = effectiveEvidence(current).find((item) => item.kind === record.kind);
    if (!head || head.id !== record.id) throw new Error(`only the current effective version can be withdrawn; ${id} (kind ${record.kind}, version ${record.version}) is not current`);
    return { ...record, withdrawn: true };
  }

  currentByKind(records: EvidenceRecord[]): Map<string, EvidenceRecord> {
    const map = new Map<string, EvidenceRecord>();
    for (const record of effectiveEvidence(records)) map.set(record.kind, record);
    return map;
  }
}
