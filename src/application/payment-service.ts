import { ClaimService } from './claim-service';
import { PaymentLedger } from '../domain/payment-ledger';
export class PaymentService {
  constructor(private readonly claims: ClaimService, private readonly ledger: PaymentLedger) {}
  settle(claimId: string, input: { amount: number; currency: string; sourceId: string }, actor: string) {
    const claim = this.claims.get(claimId);
    if (claim.status === 'rejected') throw new Error('rejected claim cannot be paid');
    const adjustment = claim.conclusions.filter((conclusion) => conclusion.kind === 'adjustment' && conclusion.status === 'active').at(-1);
    const everAdjusted = claim.conclusions.some((conclusion) => conclusion.kind === 'adjustment');
    if (!adjustment && everAdjusted) throw new Error('adjustment conclusion is invalidated by an older evidence version change: recalculation required before payment');
    const approvedMinor = adjustment ? (adjustment.payload as { approvedMinor: number }).approvedMinor : 0;
    const alreadyPaid = this.ledger.balance(claim.payments);
    const amountMinor = Math.round(input.amount * 100);
    if (alreadyPaid + amountMinor > approvedMinor) throw new Error('payment exceeds approved amount');
    const payment = this.ledger.post(claim.payments, { ...input, kind: 'settlement' });
    return this.claims.addEvent(claimId, 'payment.settled', { payment, adjustmentId: adjustment!.id }, actor, `payment:${input.sourceId}`);
  }
  reverse(claimId: string, input: { amount: number; currency: string; sourceId: string }, actor: string) {
    const claim = this.claims.get(claimId); const payment = this.ledger.post(claim.payments, { ...input, kind: 'reversal' });
    return this.claims.addEvent(claimId, 'payment.reversed', { payment }, actor, `reversal:${input.sourceId}`);
  }
}
