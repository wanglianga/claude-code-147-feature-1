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

// ---------- 同村合作民宿（超卖转住） ----------
@Entity('partner_homestays')
export class PartnerHomestay {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @Column() name: string;
  @Column() village: string;          // 同村位置
  @Money() pricePerNight: number;    // 合作方价格（每晚每间）
  @Column({ type: 'numeric', precision: 5, scale: 2, default: 0, transformer: numTransformer })
  distanceKm: number;                // 距本店距离（公里）
  @Column({ default: 'available' }) status: string; // available | full | suspended
  @Column({ default: '' }) contact: string;
  @Column({ default: '' }) phone: string;
  // monthly 月结 | guest_paid 客人自付 | upfront 预付
  @Column({ default: 'monthly' }) settlementType: string;
}

// ---------- 渠道房态同步策略（复盘时调整） ----------
@Entity('channel_sync_policies')
export class ChannelSyncPolicy {
  @PrimaryGeneratedColumn() id: number;
  @Column() channelId: number;
  @ManyToOne(() => Channel) @JoinColumn({ name: 'channelId' }) channel: Channel;
  @Column({ default: 30 }) syncIntervalMin: number; // 房态同步频率（分钟）
  @Column({ default: 0 }) bufferRooms: number;      // 渠道预留缓冲房量
  @Column({ default: true }) pushOnChange: boolean; // 房态变化即时推送
  @Column({ default: '' }) note: string;
  @Column({ type: 'timestamptz', nullable: true }) updatedAt: Date;
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
  // 会员等级：regular 普通 | silver 白银 | gold 黄金 | platinum 铂金（超卖处置优先级因子）
  @Column({ default: 'regular' }) memberLevel: string;
  // 客人预计到店时间（ISO 时间，超卖处置优先级因子）
  @Column({ type: 'timestamptz', nullable: true }) etaTime: Date;
  // 转住合作民宿后记录实际入住的合作方（防止后续渠道仍按原房型结算）
  @Column({ nullable: true }) relocatedToPartnerId: number;
  @ManyToOne(() => PartnerHomestay, { nullable: true })
  @JoinColumn({ name: 'relocatedToPartnerId' }) relocatedToPartner: PartnerHomestay;

  @Money() roomFee: number;
  @Money() extraBedFee: number;
  @Money() breakfastFee: number;
  @Money() petFee: number;
  @Money() totalAmount: number;
  @Money() depositAmount: number;
  @Money() depositDeducted: number; // 押金扣款（如宠物损坏）
  @Money() depositReturned: number;

  // booked | checked_in | checked_out | cancelled | relocated(转住合作民宿) | refunded(超卖退款)
  @Column({ default: 'booked' }) status: string;
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
  @Column({ nullable: true }) oversellCaseId: number;
  @Column() type: string; // cash 现金 | voucher 补偿券 | refund 退款
  @Money() amount: number;
  @Column({ nullable: true }) voucherCode: string;
  @Column({ default: 'issued' }) status: string; // issued | used | cancelled
  @Column({ default: '' }) reason: string;
  @CreateDateColumn() createdAt: Date;
}

// ---------- 超卖换房补偿工单 ----------
@Entity('oversell_cases')
export class OversellCase {
  @PrimaryGeneratedColumn() id: number;
  @Column({ unique: true }) code: string;
  @Column() incidentId: number;
  @ManyToOne(() => Incident) @JoinColumn({ name: 'incidentId' }) incident: Incident;
  @Column() bookingId: number;
  @ManyToOne(() => Booking) @JoinColumn({ name: 'bookingId' }) booking: Booking;
  @Column() roomTypeId: number;
  @ManyToOne(() => RoomType) @JoinColumn({ name: 'roomTypeId' }) roomType: RoomType;
  @Column() channelId: number;
  @ManyToOne(() => Channel) @JoinColumn({ name: 'channelId' }) channel: Channel;
  // 责任渠道：通常=下单渠道；OTA 延迟同步导致其他渠道客人受害时可为 OTA
  @Column({ nullable: true }) responsibleChannelId: number;
  @ManyToOne(() => Channel, { nullable: true }) @JoinColumn({ name: 'responsibleChannelId' }) responsibleChannel: Channel;
  @Column({ nullable: true }) duplicateBookingId: number; // 同房同晚另一张已占房订单（保留房一方）

  // 处置因子快照
  @Column({ type: 'timestamptz' }) orderedAt: Date;   // 下单时间
  @Column({ type: 'timestamptz' }) etaTime: Date;     // 到店时间
  @Column({ default: 'regular' }) memberLevel: string;
  @Money() roomTypeValue: number;                      // 房型价值（原房型房费）
  @Column({ type: 'numeric', precision: 6, scale: 2, default: 0, transformer: numTransformer })
  priorityScore: number;                               // 综合保留优先级得分

  // open 方案生成中 | arranged 方案已安排 | accepted 客人已接受 | rejected 客人拒绝 | closed
  @Column({ default: 'open' }) status: string;
  // upgrade 店内升级 | partner 合作民宿转住 | refund 退款补偿
  @Column({ nullable: true }) resolutionType: string;
  @Column({ nullable: true }) upgradedRoomId: number;
  @ManyToOne(() => Room, { nullable: true }) @JoinColumn({ name: 'upgradedRoomId' }) upgradedRoom: Room;
  @Column({ nullable: true }) partnerId: number;
  @ManyToOne(() => PartnerHomestay, { nullable: true }) @JoinColumn({ name: 'partnerId' }) partner: PartnerHomestay;
  @Money() partnerPricePerNight: number;     // 合作方结算价快照
  @Column({ type: 'numeric', precision: 5, scale: 2, default: 0, transformer: numTransformer })
  distanceKm: number;
  @Column({ default: 'monthly' }) partnerSettlementType: string; // monthly | guest_paid | upfront
  @Column({ type: 'numeric', precision: 4, scale: 2, default: 0, transformer: numTransformer })
  partnerCommission: number;                 // 平台付给合作方的服务费比例（结算口径）
  @Money() compensationCost: number;         // 补偿成本（现金/券/退款）
  @Money() partnerCost: number;              // 合作方房费支出
  @Money() channelClaimAmount: number;       // 向渠道索赔金额
  @Column({ default: 'pending' }) channelClaimStatus: string; // pending | claimed | settled | waived
  @Column({ default: 'platform' }) channelResponsibility: string; // channel 渠道全责 | shared 共担 | platform 平台承担
  @Column({ type: 'numeric', precision: 4, scale: 1, default: 0, transformer: numTransformer })
  guestSatisfaction: number;                 // 客人满意度 1-5
  @Column({ type: 'timestamptz', nullable: true }) acceptedAt: Date;
  @Column({ type: 'text', default: '' }) guestNote: string;
  @Column({ type: 'text', default: '' }) resolution: string;
  @Column({ default: false }) settlementLocked: boolean; // 接受后结算口径锁定
  @CreateDateColumn() createdAt: Date;
}

export const ALL_ENTITIES = [
  User, RoomType, Room, Channel, DailyPrice, DailyInventory, Booking,
  CleaningTask, LinenItem, LinenDelivery, MaintenanceTicket, BreakfastPrep,
  Incident, Review, Compensation, PartnerHomestay, ChannelSyncPolicy, OversellCase,
];
