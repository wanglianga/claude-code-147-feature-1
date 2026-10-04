import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param,
  Post, Put, Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import {
  Booking, Channel, ChannelSyncPolicy, Compensation, DailyInventory, DailyPrice,
  Incident, OversellCase, PartnerHomestay, Room, RoomType,
} from '../entities';
import { eachDay, round2 } from '../common/util';

const MEMBER_SCORE: Record<string, number> = { regular: 0, silver: 8, gold: 20, platinum: 28 };
export const MEMBER_LEVELS: Record<string, string> = {
  regular: '普通会员', silver: '白银会员', gold: '黄金会员', platinum: '铂金会员',
};
const ACTIVE_BOOKING = ['booked', 'checked_in'];
// 已在住客人不参与超卖搬迁排名（无论优先级都保留房间）
const RANKABLE = ['booked'];

interface RankRow { booking: Booking; score: number; orderPts: number; etaPts: number; memberPts: number; valuePts: number; }

// 组内相对排名打分：下单早/到店早 各最高 24 分（按组内名次线性递减），
// 会员等级取固定分，房型价值按组内最高房费归一化到 24 分
function rankBookings(group: Booking[]): Map<number, RankRow> {
  const n = group.length;
  const pts = (rank: number) => (n <= 1 ? 24 : round2(24 * (1 - rank / (n - 1))));
  const orderAsc = [...group].sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  const etaOf = (b: Booking) => new Date(b.etaTime || `${b.checkIn}T14:00:00+08:00`).getTime();
  const etaAsc = [...group].sort((a, b) => etaOf(a) - etaOf(b));
  const maxFee = Math.max(...group.map((b) => Number(b.roomFee)), 1);
  const map = new Map<number, RankRow>();
  group.forEach((b) => {
    const orderPts = pts(orderAsc.findIndex((x) => x.id === b.id));
    const etaPts = pts(etaAsc.findIndex((x) => x.id === b.id));
    const memberPts = MEMBER_SCORE[b.memberLevel] || 0;
    const valuePts = round2((Number(b.roomFee) / maxFee) * 24);
    map.set(b.id, {
      booking: b, score: round2(orderPts + etaPts + memberPts + valuePts),
      orderPts, etaPts, memberPts, valuePts,
    });
  });
  return map;
}

@Controller('oversell')
export class OversellController {
  constructor(
    @InjectRepository(OversellCase) private cases: Repository<OversellCase>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(Room) private rooms: Repository<Room>,
    @InjectRepository(RoomType) private types: Repository<RoomType>,
    @InjectRepository(Channel) private channels: Repository<Channel>,
    @InjectRepository(PartnerHomestay) private partners: Repository<PartnerHomestay>,
    @InjectRepository(ChannelSyncPolicy) private policies: Repository<ChannelSyncPolicy>,
    @InjectRepository(DailyPrice) private prices: Repository<DailyPrice>,
    @InjectRepository(DailyInventory) private inventory: Repository<DailyInventory>,
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    private dataSource: DataSource,
  ) {}

  // ---------- 工单 ----------
  @Get('cases')
  async list(@Query('status') status?: string) {
    const qb = this.cases.createQueryBuilder('c')
      .leftJoinAndSelect('c.booking', 'booking')
      .leftJoinAndSelect('c.channel', 'channel')
      .leftJoinAndSelect('c.responsibleChannel', 'responsibleChannel')
      .leftJoinAndSelect('c.roomType', 'roomType')
      .leftJoinAndSelect('c.partner', 'partner')
      .leftJoinAndSelect('c.incident', 'incident')
      .orderBy('c.id', 'DESC');
    if (status) qb.andWhere('c.status = :status', { status });
    return qb.getMany();
  }

  // 从待处理超卖事件生成处置工单（自动快照四因子并打分）
  @Post('cases')
  async createCase(@Body() body: { incidentId?: number; bookingId?: number; responsibleChannelId?: number }) {
    let incident: Incident | null = null;
    if (body.incidentId) incident = await this.incidents.findOne({ where: { id: body.incidentId } });
    else if (body.bookingId) {
      incident = await this.incidents.findOne({
        where: { bookingId: body.bookingId, type: 'oversell' }, order: { id: 'DESC' },
      });
    }
    if (!incident || incident.type !== 'oversell') throw new NotFoundException('未找到关联的超卖事件');
    const booking = await this.bookings.findOne({ where: { id: incident.bookingId! } });
    if (!booking) throw new NotFoundException('超卖事件未关联订单');
    const dup = await this.cases.findOne({ where: { incidentId: incident.id } });
    if (dup) throw new BadRequestException('该超卖事件已生成处置工单');
    const group = await this.conflictGroup(booking);
    const rankable = group.filter((x) => RANKABLE.includes(x.status));
    const ranked = rankBookings(rankable);
    const mine = ranked.get(booking.id);
    const score = mine?.score || 0;
    // 保留方优先取同房的另一单；否则取组内得分最高者
    const keeper = group
      .filter((b) => b.id !== booking.id)
      .sort((a, b) => {
        if (a.roomId === booking.roomId && b.roomId !== booking.roomId) return -1;
        if (b.roomId === booking.roomId && a.roomId !== booking.roomId) return 1;
        return (ranked.get(b.id)?.score || 0) - (ranked.get(a.id)?.score || 0);
      })[0];
    const code = 'OS26' + String(Date.now()).slice(-6);
    const responsibleChannelId = body.responsibleChannelId
      ? (await this.channels.findOne({ where: { id: body.responsibleChannelId } }))?.id ?? booking.channelId
      : booking.channelId;
    const oc = await this.cases.save(this.cases.create({
      code, incidentId: incident.id, bookingId: booking.id, roomTypeId: booking.roomTypeId,
      channelId: booking.channelId, responsibleChannelId,
      duplicateBookingId: keeper?.id || null,
      orderedAt: booking.createdAt, etaTime: booking.etaTime || new Date(`${booking.checkIn}T14:00:00+08:00`),
      memberLevel: booking.memberLevel, roomTypeValue: Number(booking.roomFee), priorityScore: score,
      compensationCost: 0, partnerCost: 0, channelClaimAmount: 0,
      channelResponsibility: 'channel', channelClaimStatus: 'pending',
    }));
    return this.caseDetail(oc.id);
  }

  @Get('cases/:id')
  async caseDetail(@Param('id') id: number) {
    const oc = await this.cases.findOne({
      where: { id },
      relations: ['booking', 'channel', 'responsibleChannel', 'roomType', 'partner', 'incident', 'upgradedRoom'],
    });
    if (!oc) throw new NotFoundException('处置工单不存在');
    const plan = oc.status === 'open' || oc.status === 'rejected' ? await this.buildPlan(oc) : null;
    return { ...oc, plan };
  }

  // 同房型、日期重叠的有效订单（含本人）
  private async conflictGroup(b: Booking) {
    const all = await this.bookings.find({ where: { roomTypeId: b.roomTypeId }, relations: ['room'] });
    return all.filter((x) => ACTIVE_BOOKING.includes(x.status)
      && x.checkIn < b.checkOut && x.checkOut > b.checkIn);
  }

  // 生成三类方案：店内升级 / 同村合作民宿转住 / 退款补偿
  private async buildPlan(oc: OversellCase) {
    const booking = await this.bookings.findOne({ where: { id: oc.bookingId } });
    if (!booking) throw new NotFoundException('订单不存在');
    const group = await this.conflictGroup(booking);
    // 在住客人直接保留；待入住订单按四因子组内排名
    const inhouse = group.filter((b) => b.status === 'checked_in');
    const rankable = group.filter((b) => RANKABLE.includes(b.status));
    const scoreMap = rankBookings(rankable);
    const ranked = rankable
      .map((b) => {
        const r = scoreMap.get(b.id)!;
        return {
          bookingId: b.id, code: b.code, guestName: b.guestName, roomId: b.roomId, roomCode: b.room.code,
          orderedAt: b.createdAt, etaTime: b.etaTime || `${b.checkIn}T14:00:00+08:00`,
          memberLevel: b.memberLevel, roomFee: Number(b.roomFee),
          orderPts: r.orderPts, etaPts: r.etaPts, memberPts: r.memberPts, valuePts: r.valuePts,
          score: r.score, keeper: b.id !== booking.id,
        };
      })
      .sort((a, b) => b.score - a.score);
    const myRank = ranked.findIndex((r) => r.bookingId === booking.id) + 1;
    const sameRoom = ranked.find((r) => r.bookingId !== booking.id && r.roomId === booking.roomId);
    const topOther = ranked.find((r) => r.bookingId !== booking.id) || null;
    const keeper = sameRoom || topOther;

    const dates = eachDay(booking.checkIn, booking.checkOut);
    // 方案一：店内升级房（更高价值房型当晚物理空房）
    const occupiedRoomIds = new Set((await this.bookings.find({
      where: [{ status: 'booked' }, { status: 'checked_in' }],
    })).filter((b) => b.status !== 'relocated' && b.status !== 'refunded'
      && b.checkIn < booking.checkOut && b.checkOut > booking.checkIn).map((b) => b.roomId));
    const allRooms = await this.rooms.find({ relations: ['roomType'] });
    const upgrades: any[] = [];
    for (const room of allRooms) {
      if (room.roomTypeId === booking.roomTypeId || occupiedRoomIds.has(room.id) || room.status === 'maintenance') continue;
      if (Number(room.roomType.basePrice) <= Number(oc.roomTypeValue) / booking.nights) continue;
      let newFee = 0;
      for (const d of dates) {
        const p = await this.prices.findOne({ where: { roomTypeId: room.roomTypeId, date: d } });
        newFee += p ? Number(p.price) : Number(room.roomType.basePrice);
      }
      const diff = round2(newFee - Number(booking.roomFee));
      if (diff >= 0) {
        upgrades.push({
          roomId: room.id, roomCode: room.code, roomType: room.roomType.name,
          newRoomTypeId: room.roomTypeId, newFee, upgradeCost: diff,
        });
      }
    }
    upgrades.sort((a, b) => a.upgradeCost - b.upgradeCost);

    // 方案二：同村合作民宿
    const partners = await this.partners.find({ where: { status: 'available' }, order: { distanceKm: 'ASC' } });
    const partnerOptions = partners.map((p) => ({
      partnerId: p.id, name: p.name, village: p.village, distanceKm: Number(p.distanceKm),
      pricePerNight: Number(p.pricePerNight), totalCost: round2(Number(p.pricePerNight) * booking.nights),
      settlementType: p.settlementType, contact: p.contact, phone: p.phone,
    }));

    // 方案三：全额退款
    const refund = {
      refundAmount: Number(booking.totalAmount),
      paidAmount: Number(booking.totalAmount),
      commission: round2(Number(booking.roomFee) * Number(oc.channel?.commissionRate || 0)),
    };

    let recommendation = 'refund';
    if (upgrades.length) recommendation = 'upgrade';
    else if (partnerOptions.length) recommendation = 'partner';
    // 渠道默认索赔建议（渠道责任：补偿成本+合作方支出+原单佣金）
    const channelRate = Number((oc as any).channel?.commissionRate ?? 0);
    return {
      factors: {
        orderedAt: booking.createdAt,
        etaTime: booking.etaTime || `${booking.checkIn}T14:00:00+08:00`,
        memberLevel: booking.memberLevel, roomTypeValue: Number(booking.roomFee),
        priorityScore: oc.priorityScore, rank: myRank, keeper,
        inhouse: inhouse.map((b) => ({ bookingId: b.id, code: b.code, guestName: b.guestName, roomCode: b.room.code })),
      },
      ranked,
      options: { upgrade: upgrades, partner: partnerOptions, refund },
      recommendation,
      commissionRateHint: channelRate,
    };
  }

  // 管家安排方案（客人尚未接受）
  @Post('cases/:id/arrange')
  async arrange(@Param('id') id: number, @Body() body: {
    option: 'upgrade' | 'partner' | 'refund';
    roomId?: number; partnerId?: number;
    compensationType?: 'cash' | 'voucher'; compensationAmount?: number;
    refundAmount?: number;
    channelResponsibility?: 'channel' | 'shared' | 'platform';
    channelClaimAmount?: number;
    note?: string;
  }) {
    const oc = await this.cases.findOne({ where: { id }, relations: ['channel', 'responsibleChannel', 'booking'] });
    if (!oc) throw new NotFoundException('处置工单不存在');
    if (!['open', 'arranged', 'rejected'].includes(oc.status)) throw new BadRequestException('工单当前状态不可安排');
    if (!['upgrade', 'partner', 'refund'].includes(body.option)) throw new BadRequestException('方案类型不合法');
    const b = oc.booking;
    const responsibleRate = Number(oc.responsibleChannel?.commissionRate ?? oc.channel.commissionRate ?? 0);

    if (body.option === 'upgrade') {
      const plan = await this.buildPlan(oc);
      const pick = plan.options.upgrade.find((u: any) => u.roomId === body.roomId);
      if (!pick) throw new BadRequestException('所选升级房不可用');
      oc.resolutionType = 'upgrade';
      oc.upgradedRoomId = pick.roomId;
      oc.partnerId = null;
      oc.partnerCost = 0;
      // 平台承担房型差价 + 额外善意补偿
      const goodwill = round2(body.compensationAmount || 0);
      oc.compensationCost = round2(pick.upgradeCost + goodwill);
      oc.distanceKm = 0;
      oc.resolution = `安排升级至 ${pick.roomCode} ${pick.roomType}，房型差价 ¥${pick.upgradeCost} 由平台承担`
        + (goodwill ? `，另${body.compensationType === 'voucher' ? '补偿券' : '现金'} ¥${goodwill}` : '');
    } else if (body.option === 'partner') {
      const partner = await this.partners.findOne({ where: { id: body.partnerId } });
      if (!partner || partner.status !== 'available') throw new BadRequestException('合作民宿不可用');
      const plan = await this.buildPlan(oc);
      const pick = plan.options.partner.find((p: any) => p.partnerId === partner.id);
      if (!pick) throw new BadRequestException('合作方不在方案清单中');
      oc.resolutionType = 'partner';
      oc.partnerId = partner.id;
      oc.upgradedRoomId = null;
      oc.partnerPricePerNight = Number(partner.pricePerNight);
      oc.distanceKm = Number(partner.distanceKm);
      oc.partnerSettlementType = partner.settlementType;
      oc.partnerCost = pick.totalCost;
      oc.compensationCost = round2(body.compensationAmount || 0);
      oc.resolution = `转住同村合作民宿「${partner.name}」（${partner.distanceKm}km，合作价 ¥${partner.pricePerNight}/晚 × ${b.nights} 晚）`
        + (oc.compensationCost ? `，另${body.compensationType === 'voucher' ? '补偿券' : '现金'} ¥${oc.compensationCost}` : '');
    } else {
      oc.resolutionType = 'refund';
      oc.upgradedRoomId = null; oc.partnerId = null; oc.partnerCost = 0; oc.distanceKm = 0;
      oc.compensationCost = round2(body.refundAmount ?? Number(b.totalAmount));
      oc.resolution = `原单全额退款 ¥${oc.compensationCost}，协助客人另订房源`;
    }
    oc.channelResponsibility = body.channelResponsibility || 'channel';
    if (body.channelClaimAmount !== undefined) oc.channelClaimAmount = round2(body.channelClaimAmount);
    else if (oc.channelResponsibility === 'channel') {
      // 默认向责任渠道索赔：全部平台损失 + 责任渠道原单佣金
      const commission = round2(Number(b.roomFee) * responsibleRate);
      oc.channelClaimAmount = round2(oc.compensationCost + oc.partnerCost + commission);
    } else if (oc.channelResponsibility === 'shared') {
      const commission = round2(Number(b.roomFee) * responsibleRate);
      oc.channelClaimAmount = round2((oc.compensationCost + oc.partnerCost + commission) / 2);
    } else {
      oc.channelClaimAmount = 0;
    }
    if (body.note) oc.guestNote = body.note;
    oc.status = 'arranged';
    await this.cases.save(oc);
    return this.caseDetail(id);
  }

  // 客人接受：执行换房/释放库存/发放补偿/锁定结算口径
  @Post('cases/:id/accept')
  async accept(@Param('id') id: number, @Body() body: { satisfaction?: number; note?: string; compensationType?: 'cash' | 'voucher' }) {
    const oc = await this.cases.findOne({ where: { id }, relations: ['booking', 'channel', 'responsibleChannel', 'partner'] });
    if (!oc) throw new NotFoundException('处置工单不存在');
    if (oc.status !== 'arranged') throw new BadRequestException('请先安排方案再请客人确认');
    const b = oc.booking;
    const compType = body.compensationType || 'voucher';
    await this.dataSource.transaction(async (em) => {
      // 升级方案差价在换房前核算（换房后新房在占用集合中会取不到）
      let upgradePick: any = null;
      if (oc.resolutionType === 'upgrade') {
        const planNow = await this.buildPlan(oc);
        upgradePick = planNow.options.upgrade.find((u: any) => u.roomId === oc.upgradedRoomId) || null;
      }
      if (oc.resolutionType === 'upgrade') {
        const newRoom = await em.findOne(Room, { where: { id: oc.upgradedRoomId! }, relations: ['roomType'] });
        if (!newRoom) throw new BadRequestException('升级房不存在');
        const dates = eachDay(b.checkIn, b.checkOut);
        // 原房型释放 1 间占用，新房型增加 1 间占用
        for (const d of dates) {
          await em.decrement(DailyInventory, { roomTypeId: b.roomTypeId, date: d }, 'booked', 1);
          await em.increment(DailyInventory, { roomTypeId: newRoom.roomTypeId, date: d }, 'booked', 1);
        }
        b.roomId = newRoom.id; // roomTypeId 保留原房型：渠道仍按原房型结算，差价平台承担
        await em.save(b);
        // 差价+善意补偿记入补偿成本
        const diffCost = upgradePick?.upgradeCost || 0;
        const goodwill = round2(oc.compensationCost - diffCost);
        if (diffCost > 0) {
          await em.save(em.create(Compensation, {
            oversellCaseId: oc.id, bookingId: b.id, type: 'cash', amount: diffCost,
            status: 'issued', reason: `超卖升级「${newRoom.roomType.name}」房型差价（平台承担）`,
          }));
        }
        if (goodwill > 0) {
          await em.save(em.create(Compensation, {
            oversellCaseId: oc.id, bookingId: b.id, type: compType, amount: goodwill,
            voucherCode: compType === 'voucher'
              ? 'OS' + Math.random().toString(36).slice(2, 8).toUpperCase() : null,
            status: 'issued', reason: '超卖换房善意补偿',
          }));
        }
      } else if (oc.resolutionType === 'partner') {
        const dates = eachDay(b.checkIn, b.checkOut);
        for (const d of dates) {
          await em.decrement(DailyInventory, { roomTypeId: b.roomTypeId, date: d }, 'booked', 1);
        }
        b.status = 'relocated';
        b.relocatedToPartnerId = oc.partnerId;
        await em.save(b);
        if (oc.compensationCost > 0) {
          await em.save(em.create(Compensation, {
            oversellCaseId: oc.id, bookingId: b.id, type: compType, amount: oc.compensationCost,
            voucherCode: compType === 'voucher'
              ? 'OS' + Math.random().toString(36).slice(2, 8).toUpperCase() : null,
            status: 'issued', reason: `超卖转住「${oc.partner?.name}」善意补偿`,
          }));
        }
      } else {
        const dates = eachDay(b.checkIn, b.checkOut);
        for (const d of dates) {
          await em.decrement(DailyInventory, { roomTypeId: b.roomTypeId, date: d }, 'booked', 1);
        }
        b.status = 'refunded';
        b.depositReturned = Number(b.depositAmount);
        await em.save(b);
        await em.save(em.create(Compensation, {
          oversellCaseId: oc.id, bookingId: b.id, type: 'refund', amount: oc.compensationCost,
          status: 'issued', reason: '渠道超卖无法安排房源，全额退款',
        }));
      }
      oc.status = 'accepted';
      oc.acceptedAt = new Date();
      oc.settlementLocked = true;
      if (body.satisfaction !== undefined) oc.guestSatisfaction = body.satisfaction;
      if (body.note) oc.guestNote = body.note;
      oc.channelClaimStatus = oc.channelClaimAmount > 0 ? 'claimed' : 'waived';
      await em.save(oc);
      // 关闭超卖事件：保留超卖原因、补偿成本、渠道责任
      const respName = oc.responsibleChannel?.name || oc.channel?.name || '渠道';
      await em.update(Incident, { id: oc.incidentId }, {
        status: 'resolved', resolvedAt: new Date(),
        cost: round2(oc.compensationCost + oc.partnerCost),
        resolution: `[${oc.code}] ${oc.resolution}；补偿成本 ¥${oc.compensationCost}`
          + `${oc.partnerCost ? `，合作方支出 ¥${oc.partnerCost}` : ''}`
          + `；责任：${{ channel: `${respName}全责`, shared: '双方共担', platform: '平台承担' }[oc.channelResponsibility]}`
          + `${oc.channelClaimAmount ? `，已向${respName}发起索赔 ¥${oc.channelClaimAmount}` : ''}`,
      });
    });
    return this.caseDetail(id);
  }

  @Post('cases/:id/reject')
  async reject(@Param('id') id: number, @Body() body: { note?: string }) {
    const oc = await this.cases.findOne({ where: { id } });
    if (!oc) throw new NotFoundException('处置工单不存在');
    if (oc.status !== 'arranged') throw new BadRequestException('仅已安排方案可被拒绝');
    oc.status = 'rejected';
    if (body.note) oc.guestNote = body.note;
    await this.cases.save(oc);
    return this.caseDetail(id);
  }

  // 客人离店后回访满意度（合作民宿转住必填，用于合作方评估）
  @Post('cases/:id/satisfaction')
  async satisfaction(@Param('id') id: number, @Body() body: { score: number; note?: string }) {
    const oc = await this.cases.findOne({ where: { id } });
    if (!oc) throw new NotFoundException('处置工单不存在');
    if (!oc.status || !['accepted', 'closed'].includes(oc.status)) throw new BadRequestException('客人接受方案后才可回访');
    if (!body.score || body.score < 1 || body.score > 5) throw new BadRequestException('满意度需为 1-5');
    oc.guestSatisfaction = body.score;
    if (body.note) oc.guestNote = body.note;
    await this.cases.save(oc);
    return this.caseDetail(id);
  }

  // 渠道索赔到账/放弃
  @Post('cases/:id/claim')
  async claim(@Param('id') id: number, @Body() body: { status: 'settled' | 'waived'; amount?: number }) {
    const oc = await this.cases.findOne({ where: { id } });
    if (!oc) throw new NotFoundException('处置工单不存在');
    if (!['claimed', 'settled', 'waived'].includes(oc.channelClaimStatus)) {
      throw new BadRequestException('当前索赔状态不可更新');
    }
    if (body.amount !== undefined) oc.channelClaimAmount = round2(body.amount);
    oc.channelClaimStatus = body.status;
    await this.cases.save(oc);
    return this.caseDetail(id);
  }

  // ---------- 合作民宿 ----------
  @Get('partners')
  partnerList() {
    return this.partners.find({ order: { id: 'ASC' } });
  }

  @Post('partners')
  async partnerCreate(@Body() body: {
    name: string; village: string; pricePerNight: number; distanceKm: number;
    settlementType?: string; contact?: string; phone?: string;
  }) {
    if (!body.name || !body.village || !body.pricePerNight || body.distanceKm === undefined) {
      throw new BadRequestException('名称/村落/合作价/距离必填');
    }
    const count = await this.partners.count();
    return this.partners.save(this.partners.create({
      code: 'P' + String(count + 1).padStart(2, '0'),
      name: body.name, village: body.village, pricePerNight: body.pricePerNight,
      distanceKm: body.distanceKm, settlementType: body.settlementType || 'monthly',
      contact: body.contact || '', phone: body.phone || '', status: 'available',
    }));
  }

  @Put('partners/:id')
  async partnerUpdate(@Param('id') id: number, @Body() body: {
    pricePerNight?: number; distanceKm?: number; settlementType?: string;
    status?: string; contact?: string; phone?: string; name?: string;
  }) {
    const p = await this.partners.findOne({ where: { id } });
    if (!p) throw new NotFoundException('合作民宿不存在');
    Object.assign(p, body);
    return this.partners.save(p);
  }

  // ---------- 渠道同步策略 ----------
  @Get('sync-policies')
  async syncPolicies() {
    const channels = await this.channels.find({ order: { id: 'ASC' } });
    const rows = [];
    for (const ch of channels) {
      let p = await this.policies.findOne({ where: { channelId: ch.id } });
      if (!p) {
        p = await this.policies.save(this.policies.create({
          channelId: ch.id, syncIntervalMin: ch.code === 'ota' ? 60 : 15,
          bufferRooms: 0, pushOnChange: true, note: '',
        }));
      }
      rows.push({ ...p, channelName: ch.name, channelCode: ch.code, commissionRate: ch.commissionRate });
    }
    return rows;
  }

  // 店主复盘中调整同步策略（频率/缓冲房/即时推送）
  @Put('sync-policies/:channelId')
  async updatePolicy(@Param('channelId') channelId: number, @Body() body: {
    syncIntervalMin?: number; bufferRooms?: number; pushOnChange?: boolean; note?: string;
  }) {
    const ch = await this.channels.findOne({ where: { id: channelId } });
    if (!ch) throw new NotFoundException('渠道不存在');
    let p = await this.policies.findOne({ where: { channelId } });
    if (!p) p = this.policies.create({ channelId });
    if (body.syncIntervalMin !== undefined) {
      if (body.syncIntervalMin < 1 || body.syncIntervalMin > 1440) throw new BadRequestException('同步频率需在 1~1440 分钟');
      p.syncIntervalMin = body.syncIntervalMin;
    }
    if (body.bufferRooms !== undefined) {
      if (body.bufferRooms < 0) throw new BadRequestException('缓冲房量不能为负');
      p.bufferRooms = body.bufferRooms;
    }
    if (body.pushOnChange !== undefined) p.pushOnChange = body.pushOnChange;
    if (body.note !== undefined) p.note = body.note;
    p.updatedAt = new Date();
    await this.policies.save(p);
    return { ok: true };
  }

  // ---------- 超卖复盘 ----------
  @Get('review')
  async review() {
    const cases = await this.cases.find({ relations: ['channel', 'partner', 'booking'] });
    const policies = await this.syncPolicies();
    const byChannel = policies.map((p) => {
      // 按责任渠道归集（OTA 延迟同步导致电话/其他渠道客人受害时，责任计入 OTA）
      const list = cases.filter((c) => (c.responsibleChannelId || c.channelId) === p.channelId);
      const settled = list.filter((c) => c.status === 'accepted');
      return {
        channelCode: p.channelCode, channelName: p.channelName,
        syncIntervalMin: p.syncIntervalMin, bufferRooms: p.bufferRooms, pushOnChange: p.pushOnChange,
        cases: list.length, resolved: settled.length,
        compensationCost: round2(settled.reduce((s, c) => s + Number(c.compensationCost), 0)),
        partnerCost: round2(settled.reduce((s, c) => s + Number(c.partnerCost), 0)),
        claimAmount: round2(settled.reduce((s, c) => s + Number(c.channelClaimAmount), 0)),
        claimSettled: round2(settled.filter((c) => c.channelClaimStatus === 'settled')
          .reduce((s, c) => s + Number(c.channelClaimAmount), 0)),
        risk: p.syncIntervalMin >= 30 || p.bufferRooms <= 0
          ? '高（同步慢/无缓冲房）' : '可控',
      };
    });
    const partnerMap = new Map<number, any>();
    for (const c of cases.filter((x) => x.resolutionType === 'partner' && x.partnerId)) {
      const cur = partnerMap.get(c.partnerId!) || {
        partnerId: c.partnerId, name: c.partner?.name, village: c.partner?.village,
        cases: 0, satisfaction: [] as number[], settlementTypes: new Set<string>(),
        cost: 0,
      };
      cur.cases += 1;
      if (Number(c.guestSatisfaction) > 0) cur.satisfaction.push(Number(c.guestSatisfaction));
      cur.settlementTypes.add(c.partnerSettlementType);
      cur.cost = round2(cur.cost + Number(c.partnerCost));
      partnerMap.set(c.partnerId!, cur);
    }
    const partnerStats = [...partnerMap.values()].map((p) => ({
      ...p,
      avgSatisfaction: p.satisfaction.length ? round2(p.satisfaction.reduce((s: number, v: number) => s + v, 0) / p.satisfaction.length) : null,
      settlementTypes: [...p.settlementTypes],
    }));
    const responsibility = (['channel', 'shared', 'platform'] as const).map((k) => ({
      responsibility: k,
      label: { channel: '渠道全责', shared: '双方共担', platform: '平台承担' }[k],
      count: cases.filter((c) => c.channelResponsibility === k).length,
      cost: round2(cases.filter((c) => c.channelResponsibility === k)
        .reduce((s, c) => s + Number(c.compensationCost) + Number(c.partnerCost), 0)),
    }));
    return {
      total: cases.length,
      accepted: cases.filter((c) => c.status === 'accepted').length,
      open: cases.filter((c) => ['open', 'arranged', 'rejected'].includes(c.status)).length,
      totalCompensation: round2(cases.reduce((s, c) => s + Number(c.compensationCost), 0)),
      totalPartnerCost: round2(cases.reduce((s, c) => s + Number(c.partnerCost), 0)),
      totalClaim: round2(cases.reduce((s, c) => s + Number(c.channelClaimAmount), 0)),
      byChannel, partnerStats, responsibility,
    };
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([
    OversellCase, Incident, Booking, Room, RoomType, Channel, PartnerHomestay,
    ChannelSyncPolicy, DailyPrice, DailyInventory, Compensation,
  ])],
  controllers: [OversellController],
})
export class OversellModule {}
