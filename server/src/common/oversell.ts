import { Booking } from '../entities';
import { round2 } from './util';

// 会员等级权重（满分 20）
const MEMBER_SCORE: Record<string, number> = { none: 0, silver: 10, gold: 15, platinum: 20 };

export interface PrioritizedBooking {
  booking: Booking;
  score: number;
  rank: number;
  detail: { label: string; points: number; note: string }[];
}

/**
 * 超卖取舍：平台根据 下单时间、到店时间、房型（订单）价值、会员等级 给冲突客人综合评分。
 * 分高者优先保留原房；分数仅用于排优先级，不直接决定补偿金额。
 * 权重：下单时间 35 / 到店时间 25 / 订单价值 20 / 会员等级 20。
 * 到店紧迫度按冲突入住日衡量：冲突日之前已在住的客人直接满分；
 * 当日到店者越早到店越紧迫；未报到店时间按中性处理。
 */
export function prioritizeOversellBookings(bookings: Booking[], conflictDate?: string): PrioritizedBooking[] {
  if (!bookings.length) return [];
  const n = bookings.length;
  const times = bookings.map((b) => new Date(b.createdAt).getTime());
  const values = bookings.map((b) => Number(b.totalAmount));
  const minT = Math.min(...times);
  const maxT = Math.max(...times);
  const minV = Math.min(...values);
  const maxV = Math.max(...values);

  const scale = (v: number, min: number, max: number, full: number) => {
    if (max === min) return full / 2; // 全部相同给中间分，避免单项碾压
    return round2(((v - min) / (max - min)) * full);
  };

  // 当日到店客人的到店时间（小时戳），用于组内归一化
  const sameDayArrivals = conflictDate
    ? bookings
      .filter((b) => b.status === 'checked_in' || b.checkIn >= conflictDate)
      .filter((b) => b.checkIn === conflictDate && b.estimatedArrival)
      .map((b) => new Date(b.estimatedArrival!).getTime())
    : [];
  const arrMin = sameDayArrivals.length ? Math.min(...sameDayArrivals) : 0;
  const arrMax = sameDayArrivals.length ? Math.max(...sameDayArrivals) : 0;

  const arrivalOf = (b: Booking): { pts: number; note: string } => {
    if (conflictDate && (b.status === 'checked_in' || b.checkIn < conflictDate)) {
      return { pts: 25, note: '冲突日前已在住，优先保障' };
    }
    if (!b.estimatedArrival) return { pts: 12.5, note: '未报到店时间，按中性处理' };
    const t = new Date(b.estimatedArrival).getTime();
    if (!conflictDate) return { pts: 12.5, note: new Date(t).toLocaleString('zh-CN') };
    if (b.checkIn > conflictDate) return { pts: 12.5, note: `预计 ${new Date(t).toLocaleString('zh-CN')} 到店（非冲突当日，按中性）` };
    const pts = arrMin === arrMax ? 21.25 : round2(25 - scale(t, arrMin, arrMax, 25));
    return { pts, note: `预计 ${new Date(t).toLocaleString('zh-CN')} 到店，到店越早越紧迫` };
  };

  const rows = bookings.map((b) => {
    // 下单越早分越高
    const orderPts = n === 1 ? 35 : round2(35 - scale(new Date(b.createdAt).getTime(), minT, maxT, 35));
    const { pts: arrPts, note: arrNote } = arrivalOf(b);
    // 订单价值越高分越高（间夜长、加床早餐等附加价值）
    const valuePts = scale(Number(b.totalAmount), minV, maxV, 20);
    const memberPts = MEMBER_SCORE[b.memberLevel] ?? 0;
    const score = round2(orderPts + arrPts + valuePts + memberPts);
    const levelText = { none: '普卡', silver: '银卡', gold: '金卡', platinum: '白金' }[b.memberLevel] || '普卡';
    return {
      booking: b,
      score,
      rank: 0,
      detail: [
        { label: '下单时间', points: orderPts, note: `${new Date(b.createdAt).toLocaleString('zh-CN')} 下单，先订优先` },
        { label: '到店时间', points: arrPts, note: arrNote },
        { label: '订单价值', points: valuePts, note: `订单总额 ¥${b.totalAmount}（${b.nights} 晚）` },
        { label: '会员等级', points: memberPts, note: `${levelText}${b.memberPoints ? `/${b.memberPoints} 积分` : ''}` },
      ],
    };
  });

  // 排名：综合分降序，平分时先下单者优先
  rows.sort((a, b) => b.score - a.score || new Date(a.booking.createdAt).getTime() - new Date(b.booking.createdAt).getTime());
  rows.forEach((r, i) => { r.rank = i + 1; });
  return rows;
}

export const MEMBER_LEVEL_TEXT: Record<string, string> = {
  none: '普卡', silver: '银卡', gold: '金卡', platinum: '白金',
};
