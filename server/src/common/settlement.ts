import { Booking, Compensation, OversellItem } from '../entities';
import { round2 } from './util';

// 单笔订单结算：房费、加床、早餐、宠物费、押金扣留、渠道佣金、补偿支出全部列清。
// 超卖换房后：
//  - 转住合作民宿：渠道不得再按原房型结算（佣金置 0），合作方价格作为代收代付，平台只承担补贴；
//  - 升级房：按升级后房型确认房费，平台吸收的差价计入成本。
export function computeSettlement(b: Booking, compensations: Compensation[], oversellItems: OversellItem[] = []) {
  const commissionRate = Number(b.channel?.commissionRate || 0);
  const accepted = oversellItems.find((i) => i.status === 'accepted') || null;
  const partnerSettled = b.settlementBasis === 'partner_settled' && accepted?.option === 'partner';

  const compTotal = round2(compensations.reduce((s, c) => s + Number(c.amount), 0));

  const lines: { label: string; amount: number }[] = [];
  let roomRevenue = Number(b.roomFee);
  let commission = round2(Number(b.roomFee) * commissionRate);
  let partnerPayout = 0;
  let upgradeSubsidy = 0;
  let settlementNote = '';

  if (partnerSettled) {
    // 合作方结算价（平台付给合作民宿），按合作方价格口径与渠道结算，原房型佣金取消
    partnerPayout = round2(Number(accepted.partnerPrice) * b.nights);
    roomRevenue = partnerPayout; // 代收代付：按合作方价确认
    commission = 0;
    settlementNote = accepted.settlementGuard
      || `转住合作民宿，按合作方价 ¥${accepted.partnerPrice}/晚结算，渠道不得再按原房型结算`;
    lines.push({ label: '房费（合作民宿结算价·代收）', amount: partnerPayout });
    lines.push({ label: '合作民宿转住支出（代付）', amount: -partnerPayout });
  } else if (accepted?.option === 'upgrade') {
    roomRevenue = Number(accepted.upgradePrice);
    commission = round2(roomRevenue * commissionRate);
    upgradeSubsidy = round2(Math.max(0, roomRevenue - Number(b.roomFee)) - Number(accepted.upgradeSurcharge || 0));
    lines.push({ label: '房费（升级房型）', amount: round2(roomRevenue) });
    if (Number(accepted.upgradeSurcharge) > 0) lines.push({ label: '升级加收（客人承担）', amount: round2(Number(accepted.upgradeSurcharge)) });
    if (upgradeSubsidy > 0) lines.push({ label: '升级差价补贴（平台吸收）', amount: -upgradeSubsidy });
  } else {
    lines.push({ label: '房费', amount: round2(Number(b.roomFee)) });
  }

  lines.push(
    { label: '加床费', amount: round2(Number(b.extraBedFee)) },
    { label: '早餐费', amount: round2(Number(b.breakfastFee)) },
    { label: '宠物清洁费', amount: round2(Number(b.petFee)) },
    { label: '渠道佣金', amount: -commission },
    { label: '补偿/赔付支出', amount: -compTotal },
    { label: '押金扣款留存', amount: round2(Number(b.depositDeducted)) },
  );

  const gross = round2(
    roomRevenue + Number(b.extraBedFee) + Number(b.breakfastFee) + Number(b.petFee)
    + (accepted?.option === 'upgrade' ? Number(accepted.upgradeSurcharge || 0) : 0),
  );
  const net = round2(gross - commission - compTotal - partnerPayout - upgradeSubsidy + Number(b.depositDeducted));
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
    settlementBasis: b.settlementBasis,
    channelSettlementBlocked: partnerSettled,
    settlementNote,
    oversellReason: b.oversellReason || '',
    channelResponsibility: b.channelResponsibility || '',
    partner: partnerSettled ? {
      name: (accepted as any).partner?.name || '',
      pricePerNight: Number(accepted.partnerPrice),
      payout: partnerPayout,
      distanceKm: Number(accepted.partnerDistanceKm || 0),
      method: accepted.partnerSettlementMethod,
      satisfaction: accepted.guestSatisfaction !== null ? Number(accepted.guestSatisfaction) : null,
    } : null,
    lines,
    gross,
    commission,
    commissionRate: partnerSettled ? 0 : commissionRate,
    compensation: compTotal,
    deposit: {
      collected: round2(Number(b.depositAmount)),
      deducted: round2(Number(b.depositDeducted)),
      returned: round2(Number(b.depositReturned)),
    },
    net,
  };
}
