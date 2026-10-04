import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import {
  Booking, Channel, Compensation, DailyInventory, DailyPrice, Incident, OversellCase,
  OversellItem, PartnerInn, PartnerRoom, ChannelSyncPolicy, Room, RoomType,
} from '../entities';
import { Roles } from '../common/auth';
import { prioritizeOversellBookings, MEMBER_LEVEL_TEXT } from '../common/oversell';
import { eachDay, round2 } from '../common/util';

// ================= 同村合作民宿 =================
@Controller('partners')
export class PartnersController {
  constructor(
    @InjectRepository(PartnerInn) private inns: Repository<PartnerInn>,
    @InjectRepository(PartnerRoom) private rooms: Repository<PartnerRoom>,
  ) {}

  @Get()
  list(@Query('active') active?: string) {
    return this.inns.find({ where: active === 'false' ? {} : { active: true }, order: { distanceKm: 'ASC' } });
  }

  @Roles('owner', 'housekeeper')
  @Post()
  create(@Body() body: Partial<PartnerInn>) {
    if (!body.code || !body.name || !body.village) throw new BadRequestException('合作方编号/名称/所在村必填');
    return this.inns.save(this.inns.create({
      code: body.code, name: body.name, village: body.village,
      distanceKm: Number(body.distanceKm) || 0, contactName: body.contactName || '',
      contactPhone: body.contactPhone || '', settlementMethod: body.settlementMethod || 'monthly',
      note: body.note || '', active: true,
    }));
  }

  // 合作方当日可转住房源与报价
  @Get('rooms')
  async roomList(@Query('from') from?: string, @Query('to') to?: string, @Query('date') date?: string) {
    const d0 = date || from;
    if (!d0) throw new BadRequestException('请提供 date 或 from');
    const rows = await this.rooms.find({
      where: to ? { date: In(eachDay(from!, to!)) } : { date: d0 },
      relations: ['partner'],
      order: { date: 'ASC', partnerPrice: 'ASC' },
    });
    return rows
      .filter((r) => r.partner?.active !== false)
      .map((r) => ({ ...r, remaining: r.available - r.sold }));
  }

  @Roles('owner', 'housekeeper')
  @Post('rooms')
  async upsertRoom(@Body() body: { partnerId: number; date: string; roomName: string; available?: number; partnerPrice: number }) {
    if (!body.partnerId || !body.date || !body.roomName || body.partnerPrice === undefined) {
      throw new BadRequestException('合作方/日期/房型/价格必填');
    }
    let row = await this.rooms.findOne({ where: { partnerId: body.partnerId, date: body.date, roomName: body.roomName } });
    if (!row) row = this.rooms.create({ partnerId: body.partnerId, date: body.date, roomName: body.roomName, sold: 0 });
    row.available = body.available ?? row.available ?? 1;
    row.partnerPrice = round2(Number(body.partnerPrice));
    return this.rooms.save(row);
  }
}

// ================= 渠道超卖换房补偿 =================
@Controller('oversells')
export class OversellsController {
  constructor(
    @InjectRepository(OversellCase) private cases: Repository<OversellCase>,
    @InjectRepository(OversellItem) private items: Repository<OversellItem>,
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(Room) private rooms: Repository<Room>,
    @InjectRepository(RoomType) private types: Repository<RoomType>,
    @InjectRepository(Channel) private channels: Repository<Channel>,
    @InjectRepository(DailyInventory) private inventory: Repository<DailyInventory>,
    @InjectRepository(DailyPrice) private prices: Repository<DailyPrice>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
    @InjectRepository(Compensation) private compensations: Repository<Compensation>,
    @InjectRepository(PartnerInn) private partners: Repository<PartnerInn>,
    @InjectRepository(PartnerRoom) private partnerRooms: Repository<PartnerRoom>,
    @InjectRepository(ChannelSyncPolicy) private policies: Repository<ChannelSyncPolicy>,
    private dataSource: DataSource,
  ) {}

  @Get('cases')
  async caseList() {
    const cases = await this.cases.find({
      relations: ['roomType', 'channel'], order: { detectedAt: 'DESC' },
    });
    const items = await this.items.find({ relations: ['booking', 'partner'] });
    return cases.map((c) => {
      const its = items.filter((i) => i.caseId === c.id);
      return {
        ...c,
        itemCount: its.length,
        acceptedCount: its.filter((i) => i.status === 'accepted').length,
        guestNames: its.map((i) => i.booking?.guestName).filter(Boolean),
      };
    });
  }

  // 检测某房型某日的超卖冲突并建案件（同一冲突不重复建）
  @Roles('owner', 'housekeeper')
  @Post('detect')
  async detect(@Body() body: { roomTypeId: number; date: string; delayMin?: number }) {
    if (!body.roomTypeId || !body.date) throw new BadRequestException('房型与日期必填');
    const type = await this.types.findOne({ where: { id: body.roomTypeId } });
    if (!type) throw new NotFoundException('房型不存在');
    const cap = await this.rooms.count({ where: { roomTypeId: type.id } });
    const conflict = await this.bookings.find({
      where: { roomTypeId: type.id }, relations: ['channel'],
    });
    const active = conflict
      .filter((b) => (b.status === 'booked' || b.status === 'checked_in')
        && b.settlementBasis !== 'partner_settled'
        && b.checkIn <= body.date && b.checkOut > body.date)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
    if (active.length <= cap) throw new BadRequestException(`${body.date}「${type.name}」未超卖（${active.length}/${cap}）`);

    const dup = await this.cases.findOne({
      where: { roomTypeId: type.id, date: body.date, status: In(['open', 'arranged', 'accepted']) },
    });
    if (dup) return this.buildCaseDetail(dup.id);

    // 渠道责任：超出物理房量的订单中，OTA 优先归责，否则取最晚下单者所属渠道（延迟同步的一方）
    const overflow = active.slice(cap);
    const ota = overflow.find((b) => b.channel?.code === 'ota');
    const responsible = ota?.channel
      || [...overflow].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0].channel;
    const delayMin = body.delayMin ?? 20;

    const caseId = await this.dataSource.transaction(async (em) => {
      const ranked = prioritizeOversellBookings(active, body.date);
      const displaced = ranked.find((r) => r.rank > cap)?.booking || overflow[overflow.length - 1];
      // 若已存在指向该冲突订单的待处理超卖事件则复用，避免重复建事件
      const activeIds = active.map((b) => b.id);
      let incident = await em.findOne(Incident, {
        where: { type: 'oversell', status: 'open' },
        order: { occurredAt: 'DESC' },
      });
      incident = incident && activeIds.includes(incident.bookingId) ? incident : null;
      if (!incident) {
        incident = await em.save(em.create(Incident, {
          type: 'oversell', bookingId: displaced.id,
          description: `${body.date}「${type.name}」超售 ${active.length - cap} 间（在订 ${active.length}/物理 ${cap}）：渠道「${responsible.name}」房态延迟同步约 ${delayMin} 分钟，同一房间被重复售出，待生成换房补偿方案`,
          status: 'open', cost: 0,
        }));
      }
      const c = await em.save(em.create(OversellCase, {
        code: 'OS' + body.date.replace(/-/g, '').slice(2) + String(Math.floor(1000 + active.length * 37 + cap)).slice(-3),
        roomTypeId: type.id, channelId: responsible.id, date: body.date,
        channelResponsibility: `${responsible.code}_delayed_sync`,
        reason: `渠道「${responsible.name}」房态延迟同步约 ${delayMin} 分钟，致 ${body.date}「${type.name}」重复售出`,
        status: 'open', detectedAt: new Date(), totalCompensationCost: 0, incidentId: incident.id,
      }));
      for (const r of ranked) {
        const retain = r.rank <= cap;
        await em.save(em.create(OversellItem, {
          caseId: c.id, bookingId: r.booking.id, priorityScore: r.score, rank: r.rank,
          scoreDetail: JSON.stringify(r.detail),
          // 排名在物理房量内的客人直接保留原房；其余客人进入换房补偿流程
          option: retain ? 'keep' : '',
          status: retain ? 'kept' : 'pending',
          decidedAt: retain ? new Date() : null,
          upgradePrice: 0, upgradeSurcharge: 0, partnerPrice: 0,
          compensationAmount: 0, platformCost: 0,
        }));
      }
      return c.id;
    });
    return this.buildCaseDetail(caseId);
  }

  @Get('cases/:id')
  async detail(@Param('id') id: number) {
    return this.buildCaseDetail(id);
  }

  private async buildCaseDetail(id: number) {
    const c = await this.cases.findOne({ where: { id }, relations: ['roomType', 'channel'] });
    if (!c) throw new NotFoundException('超卖案件不存在');
    const items = await this.items.find({
      where: { caseId: id },
      relations: ['booking', 'booking.channel', 'booking.room', 'booking.roomType',
        'upgradeRoom', 'partner'],
      order: { rank: 'ASC' },
    });
    const cap = await this.rooms.count({ where: { roomTypeId: c.roomTypeId } });
    const partnerRows = await this.partnerRooms.find({
      where: { date: In([...new Set(items.map((i) => i.booking.checkIn))]) },
      relations: ['partner'],
    });

    const enriched = [] as any[];
    for (const it of items) {
      const b = it.booking;
      // 可升级房：价格更高的房型、全程不冲突且不在维修的空房
      const busy = await this.bookings.find({ where: { status: In(['booked', 'checked_in']) } });
      const upgradeOptions: any[] = [];
      for (const room of await this.rooms.find({ relations: ['roomType'], order: { roomTypeId: 'ASC' } })) {
        if (room.status === 'maintenance' || room.roomTypeId === b.roomTypeId) continue;
        if (Number(room.roomType.basePrice) <= Number(b.roomType.basePrice)) continue;
        const clash = busy.some((x) => x.id !== b.id && x.roomId === room.id && x.settlementBasis !== 'partner_settled'
          && x.checkIn < b.checkOut && x.checkOut > b.checkIn);
        if (clash) continue;
        const nights = eachDay(b.checkIn, b.checkOut);
        let total = 0;
        for (const d of nights) {
          const p = await this.prices.findOne({ where: { roomTypeId: room.roomTypeId, date: d } });
          total += p ? Number(p.price) : Number(room.roomType.basePrice);
        }
        upgradeOptions.push({
          roomId: room.id, roomCode: room.code, roomTypeId: room.roomTypeId,
          roomTypeName: room.roomType.name, nightlyBase: Number(room.roomType.basePrice),
          totalPrice: round2(total), absorbedDiff: round2(Math.max(0, total - Number(b.roomFee))),
        });
      }
      const partnerOptions = partnerRows
        .filter((p) => p.partner?.active && p.date === b.checkIn && p.available - p.sold > 0)
        .sort((a, p) => Number(a.partnerPrice) - Number(p.partnerPrice))
        .map((p) => ({
          partnerRoomId: p.id, partnerId: p.partner.id, partnerName: p.partner.name,
          village: p.partner.village, distanceKm: Number(p.partner.distanceKm),
          roomName: p.roomName, partnerPrice: Number(p.partnerPrice),
          payout: round2(Number(p.partnerPrice) * b.nights),
          settlementMethod: p.partner.settlementMethod, remaining: p.available - p.sold,
        }));
      enriched.push({
        ...it,
        scoreDetails: safeParse(it.scoreDetail),
        memberLevelText: MEMBER_LEVEL_TEXT[b.memberLevel] || '普卡',
        retain: it.rank <= cap, // 排名在物理房量内 → 建议保留原房
        upgradeOptions: it.option === 'upgrade' ? upgradeOptions : upgradeOptions.slice(0, 6),
        partnerOptions,
      });
    }
    return { ...c, capacity: cap, items: enriched };
  }

  // 管家为某位客人提出处理方案（升级/转住/退款）
  @Roles('owner', 'housekeeper')
  @Post('items/:id/propose')
  async propose(@Param('id') id: number, @Body() body: {
    option: string; upgradeRoomId?: number; partnerId?: number; partnerRoomId?: number;
    compensationType?: string; compensationAmount?: number; surcharge?: number; note?: string;
  }) {
    const it = await this.items.findOne({ where: { id }, relations: ['booking', 'booking.roomType'] });
    if (!it) throw new NotFoundException('处理项不存在');
    if (!['upgrade', 'partner', 'refund'].includes(body.option)) throw new BadRequestException('方案需为 upgrade/partner/refund');
    const b = it.booking;
    const compAmt = round2(Number(body.compensationAmount) || 0);
    if (['refund'].includes(body.option) && compAmt <= 0) throw new BadRequestException('退款方案需填写退款/补偿金额');
    let platformCost = compAmt;

    if (body.option === 'upgrade') {
      if (!body.upgradeRoomId) throw new BadRequestException('请选择升级房间');
      const room = await this.rooms.findOne({ where: { id: body.upgradeRoomId }, relations: ['roomType'] });
      if (!room) throw new NotFoundException('升级房间不存在');
      if (Number(room.roomType.basePrice) <= Number(b.roomType.basePrice)) {
        throw new BadRequestException('升级房房型价值需高于原房型');
      }
      let total = 0;
      for (const d of eachDay(b.checkIn, b.checkOut)) {
        const p = await this.prices.findOne({ where: { roomTypeId: room.roomTypeId, date: d } });
        total += p ? Number(p.price) : Number(room.roomType.basePrice);
      }
      const surcharge = round2(Number(body.surcharge) || 0);
      it.upgradeRoomId = room.id;
      it.upgradeRoomTypeId = room.roomTypeId;
      it.upgradePrice = round2(total);
      it.upgradeSurcharge = surcharge;
      platformCost = round2(Math.max(0, total - Number(b.roomFee)) - surcharge + compAmt);
    }

    if (body.option === 'partner') {
      const pr = await this.partnerRooms.findOne({ where: { id: body.partnerRoomId }, relations: ['partner'] });
      if (!pr) throw new NotFoundException('合作房源不存在');
      if (pr.date !== b.checkIn) throw new BadRequestException('合作房源日期需与入住日一致');
      if (pr.available - pr.sold <= 0) throw new BadRequestException('合作方该房型已无剩余房量');
      const payout = round2(Number(pr.partnerPrice) * b.nights);
      it.partnerId = pr.partner.id;
      it.partnerRoomId = pr.id;
      it.partnerDate = pr.date;
      it.partnerPrice = Number(pr.partnerPrice);
      it.partnerDistanceKm = Number(pr.partner.distanceKm);
      it.partnerSettlementMethod = pr.partner.settlementMethod;
      it.settlementGuard = `转住「${pr.partner.name}」按合作方价 ¥${pr.partnerPrice}/晚×${b.nights}（${SETTLE_TEXT[pr.partner.settlementMethod]}）结算，渠道不得再按原房型结算`;
      platformCost = round2(payout + compAmt);
    }

    it.option = body.option;
    it.status = 'proposed';
    it.compensationType = body.option === 'refund' ? (body.compensationType || 'refund') : (body.compensationType || '');
    it.compensationAmount = compAmt;
    it.platformCost = platformCost;
    it.guestResponse = body.note || '';
    await this.items.save(it);
    await this.maybeArranged(it.caseId);
    return this.buildCaseDetail(it.caseId);
  }

  // 客人接受/拒绝方案；接受后落账：原订单保留超卖原因、补偿成本、渠道责任，库存与合作方占用同步
  @Roles('owner', 'housekeeper')
  @Post('items/:id/decide')
  async decide(@Param('id') id: number, @Body() body: { accepted: boolean; response?: string }) {
    const it = await this.items.findOne({ where: { id }, relations: ['booking', 'partner', 'upgradeRoom'] });
    if (!it) throw new NotFoundException('处理项不存在');
    if (it.status !== 'proposed') throw new BadRequestException('该方案尚未提议或已决定');
    if (!body.accepted) {
      it.status = 'declined';
      it.decidedAt = new Date();
      it.guestResponse = `客人拒绝：${body.response || '不接受当前方案，需重新协调'}`;
      await this.items.save(it);
      return this.buildCaseDetail(it.caseId);
    }

    await this.dataSource.transaction(async (em) => {
      const c = await em.findOne(OversellCase, { where: { id: it.caseId } });
      const b = await em.findOne(Booking, { where: { id: it.bookingId }, relations: ['channel', 'roomType'] });
      const dates = eachDay(b.checkIn, b.checkOut);

      // 原订单保留：超卖原因、渠道责任、补偿成本（复盘追责与结算依据）
      b.oversellCaseId = c.id;
      b.oversellReason = c.reason;
      b.channelResponsibility = c.channelResponsibility;
      b.oversellCompensationCost = it.platformCost;

      // 补偿落账（退款/现金/补偿券），进入结算与链路
      if (it.compensationAmount > 0 && it.compensationType) {
        const ctype = it.compensationType === 'voucher' ? 'voucher' : it.compensationType === 'cash' ? 'cash' : 'refund';
        const voucherCode = ctype === 'voucher'
          ? 'VC' + Math.random().toString(36).slice(2, 8).toUpperCase() : null;
        await em.save(em.create(Compensation, {
          bookingId: b.id, incidentId: c.incidentId, type: ctype, amount: it.compensationAmount,
          voucherCode, status: 'issued',
          reason: `超卖换房补偿（案件 ${c.code}，${OPTION_TEXT[it.option]}）`,
        }));
      }

      if (it.option === 'upgrade') {
        // 原房型释放 1 间夜，升级房型占用对应房
        for (const d of dates) {
          await em.decrement(DailyInventory, { roomTypeId: b.roomTypeId, date: d }, 'booked', 1);
          await em.increment(DailyInventory, { roomTypeId: it.upgradeRoomTypeId!, date: d }, 'booked', 1);
        }
        b.roomId = it.upgradeRoomId!;
        b.roomTypeId = it.upgradeRoomTypeId!;
      } else if (it.option === 'partner') {
        for (const d of dates) {
          await em.decrement(DailyInventory, { roomTypeId: b.roomTypeId, date: d }, 'booked', 1);
        }
        b.settlementBasis = 'partner_settled'; // 后续渠道按合作方价格口径结算
        const pr = await em.findOne(PartnerRoom, { where: { id: it.partnerRoomId! } });
        if (pr) { pr.sold += 1; await em.save(pr); }
      } else if (it.option === 'refund') {
        for (const d of dates) {
          await em.decrement(DailyInventory, { roomTypeId: b.roomTypeId, date: d }, 'booked', 1);
        }
        b.status = 'cancelled';
      }

      await em.save(b);
      it.status = 'accepted';
      it.decidedAt = new Date();
      it.guestResponse = body.response || '客人接受方案';
      await em.save(it);

      // 案件补偿成本合计
      const all = await em.find(OversellItem, { where: { caseId: c.id } });
      c.totalCompensationCost = round2(all.filter((x) => x.status === 'accepted')
        .reduce((s, x) => s + Number(x.platformCost), 0));
      const settled = all.filter((x) => !['kept'].includes(x.status));
      const pending = settled.some((x) => x.status !== 'accepted');
      if (!pending) {
        c.status = 'resolved';
        c.resolvedAt = new Date();
        if (c.incidentId) {
          await em.update(Incident, c.incidentId, {
            status: 'resolved', resolvedAt: new Date(), cost: c.totalCompensationCost,
            resolution: `换房补偿全部落实：${settled.map((x) => OPTION_TEXT[x.option]).join('、')}，合计成本 ¥${c.totalCompensationCost}`,
          });
        }
      } else {
        c.status = 'accepted';
      }
      await em.save(c);
    });
    return this.buildCaseDetail(it.caseId);
  }

  // 转住后回访：记录客人满意度
  @Roles('owner', 'housekeeper')
  @Post('items/:id/satisfaction')
  async satisfaction(@Param('id') id: number, @Body() body: { rating: number; note?: string }) {
    const it = await this.items.findOne({ where: { id } });
    if (!it) throw new NotFoundException('处理项不存在');
    const rating = Number(body.rating);
    if (!rating || rating < 1 || rating > 5) throw new BadRequestException('满意度需为 1-5 分');
    if (it.option !== 'partner') throw new BadRequestException('仅合作民宿转住需回访满意度');
    if (it.status !== 'accepted') throw new BadRequestException('客人尚未接受转住方案');
    it.guestSatisfaction = rating;
    if (body.note) it.guestResponse = `${it.guestResponse || ''}｜回访(${rating}分)：${body.note}`.trim();
    await this.items.save(it);
    return this.buildCaseDetail(it.caseId);
  }

  private async maybeArranged(caseId: number) {
    const its = (await this.items.find({ where: { caseId: caseId } })).filter((x) => x.status !== 'kept');
    if (its.length && its.every((x) => x.option && x.status === 'proposed')) {
      await this.cases.update(caseId, { status: 'arranged' });
    }
  }

  // 渠道房态同步策略（复盘用）
  @Get('sync-policies')
  async syncPolicies() {
    const channels = await this.channels.find({ order: { id: 'ASC' } });
    const rows = [];
    for (const ch of channels) {
      let p = await this.policies.findOne({ where: { channelId: ch.id } });
      if (!p) p = this.policies.create({ channelId: ch.id, syncIntervalMin: ch.code === 'ota' ? 5 : 15, safetyBuffer: 0, mode: 'auto' });
      const openCases = await this.cases.count({ where: { channelId: ch.id } });
      rows.push({ ...p, channelName: ch.name, channelCode: ch.code, oversellCases: openCases });
    }
    return rows;
  }

  @Roles('owner')
  @Post('sync-policies/:channelId')
  async updatePolicy(@Param('channelId') channelId: number, @Body() body: {
    syncIntervalMin?: number; safetyBuffer?: number; mode?: string; note?: string;
  }) {
    const ch = await this.channels.findOne({ where: { id: channelId } });
    if (!ch) throw new NotFoundException('渠道不存在');
    if (body.mode && !['auto', 'manual', 'pause'].includes(body.mode)) throw new BadRequestException('同步方式不合法');
    let p = await this.policies.findOne({ where: { channelId } });
    if (!p) p = this.policies.create({ channelId });
    if (body.syncIntervalMin !== undefined) p.syncIntervalMin = Math.max(1, Number(body.syncIntervalMin));
    if (body.safetyBuffer !== undefined) p.safetyBuffer = Math.max(0, Number(body.safetyBuffer));
    if (body.mode) p.mode = body.mode;
    if (body.note !== undefined) p.note = body.note;
    p.updatedAt = new Date();
    return this.policies.save(p);
  }
}

const safeParse = (s: string) => { try { return JSON.parse(s); } catch { return []; } };
const OPTION_TEXT: Record<string, string> = { upgrade: '升级房', partner: '合作民宿转住', refund: '退款补偿' };
const SETTLE_TEXT: Record<string, string> = { monthly: '月结', per_night: '逐晚现结', prepaid: '平台预付' };

@Module({
  imports: [TypeOrmModule.forFeature([
    OversellCase, OversellItem, Booking, Room, RoomType, Channel, DailyInventory, DailyPrice,
    Incident, Compensation, PartnerInn, PartnerRoom, ChannelSyncPolicy,
  ])],
  controllers: [PartnersController, OversellsController],
})
export class OversellsModule {}
