import { Booking, Compensation, OversellCase } from '../entities';
import { round2 } from './util';

export interface OversellSettlementInfo {
  caseCode: string;
  resolutionType: string; // upgrade | partner | refund
  partnerName?: string;
  partnerPricePerNight: number;
  partnerCost: number;
  partnerSettlementType: string;
  channelResponsibility: string;
  claimAmount: number;
  claimStatus: string;
}

// 单笔订单结算：房费、加床、早餐、宠物费、押金扣留、渠道佣金、补偿支出、
// 超卖换房（升级差价/合作民宿房费/退款）与渠道索赔全部列清
export function computeSettlement(
  b: Booking,
  compensations: Compensation[],
  oversell?: OversellCase | null,
) {
  const commissionRate = Number(b.channel?.commissionRate || 0);
  const commission = round2(Number(b.roomFee) * commissionRate);
  const compTotal = round2(compensations.reduce((s, c) => s + Number(c.amount), 0));
  const gross = round2(
    Number(b.roomFee) + Number(b.extraBedFee) + Number(b.breakfastFee) + Number(b.petFee),
  );
  const partnerCost = oversell?.resolutionType === 'partner' ? round2(Number(oversell.partnerCost)) : 0;
  const claimSettled = oversell && oversell.channelClaimStatus === 'settled'
    ? round2(Number(oversell.channelClaimAmount)) : 0;
  const net = round2(gross - commission - compTotal - partnerCost
    + claimSettled + Number(b.depositDeducted));
  const lines = [
    { label: '房费', amount: round2(Number(b.roomFee)) },
    { label: '加床费', amount: round2(Number(b.extraBedFee)) },
    { label: '早餐费', amount: round2(Number(b.breakfastFee)) },
    { label: '宠物清洁费', amount: round2(Number(b.petFee)) },
    { label: '渠道佣金', amount: -commission },
    { label: '补偿/赔付支出', amount: -compTotal },
    { label: '押金扣款留存', amount: round2(Number(b.depositDeducted)) },
  ];
  if (partnerCost > 0) {
    lines.push({
      label: `合作民宿房费支出（${oversell?.partner?.name || ''}，${{
        monthly: '月结', guest_paid: '客人自付', upfront: '预付',
      }[oversell?.partnerSettlementType || 'monthly']}，不得再按原房型结算）`,
      amount: -partnerCost,
    });
  }
  if (claimSettled > 0) lines.push({ label: '渠道超卖索赔到账', amount: claimSettled });
  return {
    bookingId: b.id,
    code: b.code,
    guestName: b.guestName,
    channel: b.channel?.name,
    channelCode: b.channel?.code,
    roomType: (b as any).roomType?.name,
    roomCode: (b as any).room?.code,
    checkIn: b.checkIn,
    checkOut: b.checkOut,
    status: b.status,
    relocatedToPartner: b.relocatedToPartnerId
      ? (b as any).relocatedToPartner?.name || `合作方#${b.relocatedToPartnerId}` : null,
    oversell: oversell ? {
      caseCode: oversell.code,
      resolutionType: oversell.resolutionType,
      partnerName: (oversell as any).partner?.name || null,
      partnerPricePerNight: Number(oversell.partnerPricePerNight),
      partnerCost,
      partnerSettlementType: oversell.partnerSettlementType,
      channelResponsibility: oversell.channelResponsibility,
      claimAmount: Number(oversell.channelClaimAmount),
      claimStatus: oversell.channelClaimStatus,
      settlementLocked: oversell.settlementLocked,
      satisfaction: Number(oversell.guestSatisfaction) || null,
    } as OversellSettlementInfo : null,
    lines,
    gross,
    commission,
    commissionRate,
    compensation: compTotal,
    partnerCost,
    claimSettled,
    deposit: {
      collected: round2(Number(b.depositAmount)),
      deducted: round2(Number(b.depositDeducted)),
      returned: round2(Number(b.depositReturned)),
    },
    net,
  };
}
