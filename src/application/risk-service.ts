import { ClaimService } from './claim-service';
import { RiskGraph } from '../domain/risk';
import { evidenceBasis } from '../domain/evidence';
import { ConclusionRecord } from '../domain/types';
import { newId, iso, stableHash } from '../domain/ids';
export class RiskService {
  constructor(private readonly claims: ClaimService, private readonly graph: RiskGraph) {}
  assess(claimId: string, actor: string) {
    const claim = this.claims.get(claimId); const signals = this.graph.link(claimId, claim.participants); const score = Math.min(100, signals.reduce((sum, signal) => sum + signal.score, 0) + (claim.loss.gross >= 100000 ? 25 : 0));
    const basis = evidenceBasis(claim.evidence);
    const conclusion: ConclusionRecord = { id: newId('conclusion'), kind: 'risk', sequence: claim.conclusions.length + 1, createdAt: iso(), actor, basis, basisHash: stableHash(basis), result: { score, signals }, status: 'active' };
    const inputHash = stableHash({ basis, gross: claim.loss.gross, participants: claim.participants });
    return this.claims.addEvent(claimId, 'risk.assessed', { score, signals, conclusion }, actor, `risk:${claimId}:${inputHash}`);
  }
  related(claimId: string) { return this.graph.neighborhood(claimId); }
}
