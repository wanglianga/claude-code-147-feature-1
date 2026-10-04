import {
  Column, CreateDateColumn, Entity, Index, JoinColumn, ManyToOne, PrimaryGeneratedColumn, Unique,
} from 'typeorm';

const numTransformer = {
  to: (v: any) => v,
  from: (v: any) => (v === null || v === undefined ? null : Number(v)),
};
const Money = (opts: any = {}) =>
  Column({ type: 'numeric', precision: 12, scale: 2, default: 0, transformer: numTransformer, ...opts });

// ---------- 用户 ----------
@Entity('users')
export class User {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) username: string;
  @Column() passwordHash: string;
  @Column() name: string;
  @Column() role: string; // owner 店主 | housekeeper 管家 | cleaner 保洁 | kitchen 厨房 | frontdesk 前台
  @CreateDateColumn() createdAt: Date;
}

// ---------- 房型 / 房间 / 渠道 ----------
@Entity('room_types')
export class RoomType {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @Column() name: string;
  @Money() basePrice: number;
  @Column({ default: 2 }) maxAdults: number;
  @Column({ default: 1 }) maxChildren: number;
  @Column({ default: false }) extraBedAllowed: boolean;
  @Money() extraBedPrice: number;
  @Column({ default: false }) petAllowed: boolean;
  @Money() petFee: number; // 宠物清洁费（一次性）
  @Money() breakfastPrice: number; // 早餐单价/份/天
  @Money() depositAmount: number; // 押金
}

@Entity('rooms')
export class Room {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @Column({ default: 1 }) floor: number;
  // 保洁状态：clean 已清洁 | dirty 待打扫 | cleaning 打扫中 | inspected 已验收 | maintenance 维修中
  @Column({ default: 'clean' }) status: string;
  @Column() roomTypeId: number;
  @ManyToOne(() => RoomType) @JoinColumn({ name: 'roomTypeId' }) roomType: RoomType;
}

@Entity('channels')
export class Channel {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string; // web | miniapp | ota | phone
  @Column() name: string;
  @Column({ type: 'numeric', precision: 5, scale: 4, default: 0, transformer: numTransformer })
  commissionRate: number; // 渠道佣金比例
}

// ---------- 价格与库存 ----------
@Entity('daily_prices')
@Unique(['roomTypeId', 'date'])
export class DailyPrice {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomTypeId: number;
  @Column({ type: 'date' }) date: string;
  @Money() price: number;
}

@Entity('daily_inventory')
@Unique(['roomTypeId', 'date'])
export class DailyInventory {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomTypeId: number;
  @Column({ type: 'date' }) date: string;
  @Column({ default: 0 }) total: number;    // 物理房量
  @Column({ default: 0 }) sellable: number; // 系统调整后的可售房量
  @Column({ default: 0 }) booked: number;   // 已订
}

// ---------- 订单 ----------
@Entity('bookings')
export class Booking {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @Column() channelId: number;
  @ManyToOne(() => Channel) @JoinColumn({ name: 'channelId' }) channel: Channel;
  @Column() roomId: number;
  @ManyToOne(() => Room) @JoinColumn({ name: 'roomId' }) room: Room;
  @Column() roomTypeId: number;
  @ManyToOne(() => RoomType) @JoinColumn({ name: 'roomTypeId' }) roomType: RoomType;

  @Column() guestName: string;
  @Column({ default: '' }) guestPhone: string;
  @Column({ type: 'date' }) checkIn: string;
  @Column({ type: 'date' }) checkOut: string;
  @Column() nights: number;
  @Column({ default: 2 }) adults: number;
  @Column({ default: 0 }) children: number;
  @Column({ default: 0 }) extraBeds: number;
  @Column({ default: 0 }) pets: number;
  @Column({ default: 0 }) breakfastCount: number; // 每日早餐份数
  @Column({ default: '' }) dietaryNotes: string;  // 忌口
  @Column({ default: false }) invoiceRequired: boolean;
  @Column({ default: '' }) invoiceTitle: string;
  @Column({ default: '' }) specialRequests: string;

  // 会员：none 普卡 | silver 银卡 | gold 金卡 | platinum 白金；超卖决策时影响优先保留权重
  @Column({ default: 'none' }) memberLevel: string;
  @Column({ default: 0 }) memberPoints: number;
  @Column({ type: 'timestamptz', nullable: true }) estimatedArrival: Date; // 客人自报/渠道回传的预计到店时间
  // 结算口径：normal 本店按原渠道 | partner_settled 转住合作民宿，按合作方价格结算（渠道不得再按原房型结算）
  @Column({ default: 'normal' }) settlementBasis: string;

  @Money() roomFee: number;
  @Money() extraBedFee: number;
  @Money() breakfastFee: number;
  @Money() petFee: number;
  @Money() totalAmount: number;
  @Money() depositAmount: number;
  @Money() depositDeducted: number; // 押金扣款（如宠物损坏）
  @Money() depositReturned: number;

  // booked | checked_in | checked_out | cancelled
  @Column({ default: 'booked' }) status: string;

  // —— 超卖换房补偿：原订单保留原因、补偿成本与渠道责任，供复盘追责与结算改口径 ——
  @Column({ default: '' }) oversellReason: string;     // 如：OTA房态延迟同步
  @Money() oversellCompensationCost: number;           // 该单实际承担的补偿成本
  @Column({ default: '' }) channelResponsibility: string; // ota_delayed_sync 等渠道责任代码
  @Column({ nullable: true }) oversellCaseId: number;  // 归属的超卖案件

  @Column({ type: 'timestamptz', nullable: true }) actualCheckIn: Date;
  @Column({ type: 'timestamptz', nullable: true }) actualCheckOut: Date;
  @CreateDateColumn() createdAt: Date;
}

// ---------- 保洁 ----------
@Entity('cleaning_tasks')
export class CleaningTask {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomId: number;
  @ManyToOne(() => Room) @JoinColumn({ name: 'roomId' }) room: Room;
  @Column({ nullable: true }) bookingId: number;
  @Column({ type: 'date' }) date: string;
  @Column({ default: 'normal' }) dirtiness: string; // light | normal | heavy
  // pending | assigned | in_progress | done | inspected
  @Column({ default: 'pending' }) status: string;
  @Column({ nullable: true }) assigneeId: number;
  @ManyToOne(() => User, { nullable: true }) @JoinColumn({ name: 'assigneeId' }) assignee: User;
  @Column({ type: 'timestamptz', nullable: true }) scheduledStart: Date;
  @Column({ type: 'timestamptz', nullable: true }) startedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) finishedAt: Date;
  @Column({ default: 0 }) linenUsed: number; // 更换布草套数
  @Column({ default: 0 }) priority: number;
  @Column({ default: '' }) notes: string;
}

// ---------- 布草 ----------
@Entity('linen_items')
export class LinenItem {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) item: string; // 床单/被套/毛巾/枕套
  @Column({ default: 0 }) total: number;
  @Column({ default: 0 }) inUse: number;
  @Column({ default: 0 }) inWash: number;
  @Column({ default: 0 }) damaged: number;
}

@Entity('linen_deliveries')
export class LinenDelivery {
  @PrimaryGeneratedColumn() id: number;
  @Column() item: string;
  @Column() quantity: number;
  @Column({ type: 'timestamptz' }) expectedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) arrivedAt: Date;
  @Column({ default: 'scheduled' }) status: string; // scheduled | delivered | delayed
  @CreateDateColumn() createdAt: Date;
}

// ---------- 维修 ----------
@Entity('maintenance_tickets')
export class MaintenanceTicket {
  @PrimaryGeneratedColumn() id: number;
  @Column() roomId: number;
  @ManyToOne(() => Room) @JoinColumn({ name: 'roomId' }) room: Room;
  @Column({ nullable: true }) bookingId: number;
  @Column() type: string; // ac | plumbing | furniture | appliance | other
  @Column() description: string;
  @Column({ default: 'open' }) status: string; // open | fixing | fixed
  @Money() cost: number;
  @CreateDateColumn() reportedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) fixedAt: Date;
}

// ---------- 早餐 ----------
@Entity('breakfast_preps')
export class BreakfastPrep {
  @PrimaryGeneratedColumn() id: number;
  @Column({ type: 'date', unique: true }) date: string;
  @Column({ default: 0 }) requiredPortions: number;
  @Column({ default: 0 }) preparedPortions: number;
  @Column({ default: 'planned' }) status: string; // planned | confirmed | shortage
  @Column({ default: '' }) note: string;
  @Column({ type: 'timestamptz', nullable: true }) confirmedAt: Date;
}

// ---------- 事件（住宿链路） ----------
@Entity('incidents')
export class Incident {
  @PrimaryGeneratedColumn() id: number;
  // late_checkout 延迟退房 | ac_failure 空调故障 | linen_delay 布草延迟 | extra_guests 临时加人
  // pet_damage 宠物损坏 | breakfast_shortage 早餐不足 | oversell 渠道超卖 | bad_review 差评 | other
  @Column() @Index() type: string;
  @Column({ nullable: true }) @Index() bookingId: number;
  @Column({ nullable: true }) roomId: number;
  @Column({ type: 'text' }) description: string;
  @Column({ default: 'open' }) status: string; // open | processing | resolved
  @Money() cost: number;
  @Column({ type: 'timestamptz', default: () => 'now()' }) occurredAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) resolvedAt: Date;
  @Column({ default: '' }) resolution: string;
}

// ---------- 差评与补偿 ----------
@Entity('reviews')
export class Review {
  @PrimaryGeneratedColumn() id: number;
  @Column() bookingId: number;
  @ManyToOne(() => Booking) @JoinColumn({ name: 'bookingId' }) booking: Booking;
  @Column() rating: number; // 1-5，<=3 为差评
  @Column() category: string; // hardware 硬件 | service 服务 | oversell 超卖 | food 餐食
  @Column({ type: 'text' }) content: string;
  @Column({ default: false }) compensated: boolean;
  @CreateDateColumn() createdAt: Date;
}

@Entity('compensations')
export class Compensation {
  @PrimaryGeneratedColumn() id: number;
  @Column({ nullable: true }) reviewId: number;
  @Column({ nullable: true }) incidentId: number;
  @Column({ nullable: true }) bookingId: number;
  @Column() type: string; // cash 现金 | voucher 补偿券 | refund 退款
  @Money() amount: number;
  @Column({ nullable: true }) voucherCode: string;
  @Column({ default: 'issued' }) status: string; // issued | used | cancelled
  @Column({ default: '' }) reason: string;
  @CreateDateColumn() createdAt: Date;
}

// ---------- 同村合作民宿（超卖转住接收方） ----------
@Entity('partner_inns')
export class PartnerInn {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @Column() name: string;
  @Column() village: string;       // 同村/邻村
  @Column({ type: 'numeric', precision: 5, scale: 1, default: 0, transformer: numTransformer })
  distanceKm: number;            // 与本店距离（公里）
  @Column() contactName: string;
  @Column({ default: '' }) contactPhone: string;
  // monthly 月结 | per_night 逐晚现结 | prepaid 平台预付
  @Column({ default: 'monthly' }) settlementMethod: string;
  @Column({ default: true }) active: boolean;
  @Column({ type: 'text', default: '' }) note: string;
}

// 合作民宿当日可接收房型与报价（按日期/房型记录合作方价格）
@Entity('partner_rooms')
@Unique(['partnerId', 'date', 'roomName'])
export class PartnerRoom {
  @PrimaryGeneratedColumn() id: number;
  @Column() partnerId: number;
  @ManyToOne(() => PartnerInn) @JoinColumn({ name: 'partnerId' }) partner: PartnerInn;
  @Column({ type: 'date' }) date: string;
  @Column() roomName: string;      // 合作方房型名称（如：观景大床/山景双床）
  @Column({ default: 1 }) available: number;
  @Money() partnerPrice: number;   // 合作方结算价（平台付给合作方）
  @Column({ default: 0 }) sold: number; // 已被本店转住占用
}

// ---------- 超卖换房案件 ----------
// 一起超卖可能涉及同一房型同一晚的多张订单；案件下挂多个客人的处理项
@Entity('oversell_cases')
export class OversellCase {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;          // OS26xxxx
  @Column() roomTypeId: number;
  @ManyToOne(() => RoomType) @JoinColumn({ name: 'roomTypeId' }) roomType: RoomType;
  @Column({ type: 'date' }) date: string;          // 冲突入住日
  @Column() channelId: number;                      // 责任渠道（超卖来源）
  @ManyToOne(() => Channel) @JoinColumn({ name: 'channelId' }) channel: Channel;
  @Column({ default: 'ota_delayed_sync' }) channelResponsibility: string; // 渠道责任代码
  @Column({ type: 'text' }) reason: string;        // 超卖原因（如 OTA 房态延迟同步 28 分钟）
  @Column({ default: 'open' }) status: string;     // open 待处理 | arranged 方案已生成 | accepted 客人已接受 | resolved 全部处理完
  @Column({ type: 'timestamptz' }) detectedAt: Date;
  @Column({ type: 'timestamptz', nullable: true }) resolvedAt: Date;
  @Column({ nullable: true }) incidentId: number;   // 关联的超卖链路事件
  @Money() totalCompensationCost: number;          // 案件补偿成本合计（本店承担）
  @Column({ default: '' }) syncNote: string;       // 复盘后对同步策略的调整结论
}

// 案件下每位冲突客人的处理项
@Entity('oversell_items')
export class OversellItem {
  @PrimaryGeneratedColumn() id: number;
  @Column() caseId: number;
  @ManyToOne(() => OversellCase) @JoinColumn({ name: 'caseId' }) oversellCase: OversellCase;
  @Column() bookingId: number;
  @ManyToOne(() => Booking) @JoinColumn({ name: 'bookingId' }) booking: Booking;

  // 平台综合评分（下单时间/到店时间/房型价值/会员等级），分高者优先保留原房
  @Column({ type: 'numeric', precision: 7, scale: 2, default: 0, transformer: numTransformer })
  priorityScore: number;
  @Column({ type: 'integer', default: 0 }) rank: number; // 同案件内排名（1 为优先保留）
  @Column({ type: 'text', default: '' }) scoreDetail: string; // 各因子得分明细

  // upgrade 升级房 | partner 同村合作民宿转住 | refund 退款补偿（自行解决）
  @Column({ default: '' }) option: string;
  @Column({ default: 'proposed' }) status: string; // proposed 已提议 | accepted 客人接受 | declined 客人拒绝
  @Column({ type: 'timestamptz', nullable: true }) decidedAt: Date;
  @Column({ type: 'text', default: '' }) guestResponse: string;

  // 升级房方案
  @Column({ nullable: true }) upgradeRoomId: number;
  @ManyToOne(() => Room, { nullable: true }) @JoinColumn({ name: 'upgradeRoomId' }) upgradeRoom: Room;
  @Column({ nullable: true }) upgradeRoomTypeId: number;
  @Money() upgradePrice: number;       // 升级房型当日价格
  @Money() upgradeSurcharge: number;   // 向客人加收（通常 0，平台吸收差价）

  // 合作民宿转住方案
  @Column({ nullable: true }) partnerId: number;
  @ManyToOne(() => PartnerInn, { nullable: true }) @JoinColumn({ name: 'partnerId' }) partner: PartnerInn;
  @Column({ nullable: true }) partnerRoomId: number;
  @Column({ type: 'date', nullable: true }) partnerDate: string;
  @Money() partnerPrice: number;       // 合作方结算价（快照）
  @Column({ type: 'numeric', precision: 5, scale: 1, nullable: true, transformer: numTransformer })
  partnerDistanceKm: number;
  @Column({ default: '' }) partnerSettlementMethod: string; // 结算方式快照
  @Column({ type: 'numeric', precision: 4, scale: 2, nullable: true, transformer: numTransformer })
  guestSatisfaction: number;           // 客人满意度 1-5（回访）
  @Column({ default: '' }) settlementGuard: string; // 防错结算提示（渠道不得再按原房型结算）

  // 退款补偿方案 / 各方案通用补偿
  @Money() compensationAmount: number; // 现金/退款补偿
  @Column({ default: '' }) compensationType: string; // cash | refund | voucher
  @Column({ type: 'numeric', precision: 12, scale: 2, default: 0, transformer: numTransformer })
  platformCost: number;                // 平台为本客人实际承担成本（差价/补贴/退款合计）
}

// ---------- 渠道房态同步策略（店主复盘时调整，防止再次超卖） ----------
@Entity('channel_sync_policies')
export class ChannelSyncPolicy {
  @PrimaryGeneratedColumn() id: number;
  @Column() channelId: number;
  @ManyToOne(() => Channel) @JoinColumn({ name: 'channelId' }) channel: Channel;
  @Column({ default: 5 }) syncIntervalMin: number;   // 房态推送间隔（分钟）
  @Column({ default: 0 }) safetyBuffer: number;      // 安全缓冲房量（预留不投放）
  // auto 自动实时同步 | manual 人工确认后放房 | pause 旺季暂停该渠道超售房投放
  @Column({ default: 'auto' }) mode: string;
  @Column({ type: 'timestamptz', default: () => 'now()' }) updatedAt: Date;
  @Column({ type: 'text', default: '' }) note: string;
}

export const ALL_ENTITIES = [
  User, RoomType, Room, Channel, DailyPrice, DailyInventory, Booking,
  CleaningTask, LinenItem, LinenDelivery, MaintenanceTicket, BreakfastPrep,
  Incident, Review, Compensation,
  PartnerInn, PartnerRoom, OversellCase, OversellItem, ChannelSyncPolicy,
];
