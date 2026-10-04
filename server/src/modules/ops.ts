import {
  BadRequestException, Body, Controller, Get, Module, NotFoundException, Param, Post, Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, In, LessThanOrEqual, MoreThanOrEqual, Repository } from 'typeorm';
import {
  Booking, BreakfastPrep, CleaningTask, Incident, LinenDelivery, LinenItem,
  MaintenanceTicket, Room, User,
} from '../entities';
import { addDays, todayStr } from '../common/util';

// ================= 保洁 =================
@Controller('cleaning')
export class CleaningController {
  constructor(
    @InjectRepository(CleaningTask) private tasks: Repository<CleaningTask>,
    @InjectRepository(Room) private rooms: Repository<Room>,
    @InjectRepository(User) private users: Repository<User>,
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(LinenItem) private linen: Repository<LinenItem>,
    @InjectRepository(MaintenanceTicket) private maintenance: Repository<MaintenanceTicket>,
    private dataSource: DataSource,
  ) {}

  @Get('tasks')
  list(@Query('date') date?: string, @Query('status') status?: string) {
    const where: any = {};
    if (date) where.date = date;
    if (status) where.status = status;
    return this.tasks.find({ where, relations: ['room', 'assignee'], order: { id: 'DESC' } });
  }

  // 智能排班：按下一单入住时间、脏污程度、维修状态、布草库存安排打扫顺序与人员
  @Post('auto-schedule')
  async autoSchedule(@Body() body: { date?: string }) {
    const date = body.date || todayStr();
    const pending = await this.tasks.find({
      where: [{ status: 'pending' }, { status: 'assigned' }],
      relations: ['room'],
    });
    const cleaners = await this.users.find({ where: { role: 'cleaner' } });
    if (!cleaners.length) throw new BadRequestException('没有可用的保洁员');
    const linenItems = await this.linen.find();
    const linenAvailable = linenItems.length
      ? Math.min(...linenItems.map((l) => l.total - l.inUse - l.inWash - l.damaged))
      : 0;
    const durationOf = (d: string) => (d === 'heavy' ? 70 : d === 'light' ? 30 : 45);
    const dirtWeight = (d: string) => (d === 'heavy' ? 2 : d === 'normal' ? 1 : 0);

    const plans: any[] = [];
    for (const t of pending) {
      const next = await this.bookings.findOne({
        where: { roomId: t.roomId, checkIn: MoreThanOrEqual(date), status: In(['booked', 'checked_in']) },
        order: { checkIn: 'ASC' },
      });
      const openFix = await this.maintenance.findOne({
        where: { roomId: t.roomId, status: In(['open', 'fixing']) },
      });
      plans.push({
        task: t,
        deadline: next ? `${next.checkIn}T14:00` : null,
        warnings: [
          ...(openFix ? [`存在未结维修单（${openFix.description}），需先维修`] : []),
          ...(linenAvailable < 1 ? ['布草库存不足，更换布草受限'] : []),
        ],
      });
    }
    // 紧急程度：有当日入住的最优先，其次按脏污
    plans.sort((a, b) => {
      const da = a.deadline || '9999';
      const db = b.deadline || '9999';
      if (da !== db) return da < db ? -1 : 1;
      return dirtWeight(b.task.dirtiness) - dirtWeight(a.task.dirtiness);
    });
    const load = new Map<number, number>(cleaners.map((c) => [c.id, 0]));
    const result: any[] = [];
    let seq = 1;
    for (const p of plans) {
      const cleaner = cleaners.reduce((a, b) => (load.get(a.id)! <= load.get(b.id)! ? a : b));
      const startMin = 9 * 60 + load.get(cleaner.id)!;
      const start = new Date(`${date}T${String(Math.floor(startMin / 60)).padStart(2, '0')}:${String(startMin % 60).padStart(2, '0')}:00+08:00`);
      const duration = durationOf(p.task.dirtiness);
      p.task.assigneeId = cleaner.id;
      p.task.scheduledStart = start;
      p.task.status = 'assigned';
      p.task.priority = seq++;
      await this.tasks.save(p.task);
      load.set(cleaner.id, load.get(cleaner.id)! + duration);
      result.push({
        taskId: p.task.id, room: p.task.room.code, dirtiness: p.task.dirtiness,
        cleaner: cleaner.name, start: start.toISOString(), durationMin: duration,
        deadline: p.deadline, warnings: p.warnings,
      });
    }
    return { date, linenAvailable, plan: result };
  }

  @Post('tasks/:id/assign')
  async assign(@Param('id') id: number, @Body() body: { cleanerId: number }) {
    const t = await this.tasks.findOne({ where: { id } });
    if (!t) throw new NotFoundException('任务不存在');
    t.assigneeId = body.cleanerId;
    t.status = 'assigned';
    return this.tasks.save(t);
  }

  @Post('tasks/:id/start')
  async start(@Param('id') id: number) {
    const t = await this.tasks.findOne({ where: { id } });
    if (!t) throw new NotFoundException('任务不存在');
    t.status = 'in_progress';
    t.startedAt = new Date();
    await this.rooms.update(t.roomId, { status: 'cleaning' });
    return this.tasks.save(t);
  }

  // 完成打扫：记录布草消耗（可用布草转入待洗）
  @Post('tasks/:id/complete')
  async complete(@Param('id') id: number, @Body() body: { linenUsed?: number; notes?: string }) {
    const t = await this.tasks.findOne({ where: { id } });
    if (!t) throw new NotFoundException('任务不存在');
    const used = body.linenUsed ?? 1;
    await this.dataSource.transaction(async (em) => {
      t.status = 'done';
      t.finishedAt = new Date();
      t.linenUsed = used;
      t.notes = body.notes || t.notes;
      await em.save(t);
      await em.update(Room, t.roomId, { status: 'clean' });
      if (used > 0) {
        const items = await em.find(LinenItem);
        for (const item of items) {
          const avail = item.total - item.inUse - item.inWash - item.damaged;
          const take = Math.min(avail, used);
          if (take > 0) {
            item.inWash += take;
            await em.save(item);
          }
        }
      }
    });
    return this.tasks.findOne({ where: { id }, relations: ['room', 'assignee'] });
  }

  @Post('tasks/:id/inspect')
  async inspect(@Param('id') id: number) {
    const t = await this.tasks.findOne({ where: { id } });
    if (!t) throw new NotFoundException('任务不存在');
    if (t.status !== 'done') throw new BadRequestException('任务尚未完成');
    t.status = 'inspected';
    await this.rooms.update(t.roomId, { status: 'inspected' });
    return this.tasks.save(t);
  }
}

// ================= 布草 =================
@Controller('linen')
export class LinenController {
  constructor(
    @InjectRepository(LinenItem) private items: Repository<LinenItem>,
    @InjectRepository(LinenDelivery) private deliveries: Repository<LinenDelivery>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
  ) {}

  @Get('stock')
  stock() {
    return this.items.find({ order: { id: 'ASC' } }).then((rows) =>
      rows.map((r) => ({ ...r, available: r.total - r.inUse - r.inWash - r.damaged })));
  }

  @Get('deliveries')
  deliveryList() {
    return this.deliveries.find({ order: { expectedAt: 'DESC' } });
  }

  @Post('deliveries')
  createDelivery(@Body() body: { item: string; quantity: number; expectedAt: string }) {
    if (!body.item || !body.quantity || !body.expectedAt) throw new BadRequestException('参数不完整');
    return this.deliveries.save(this.deliveries.create({
      item: body.item, quantity: body.quantity, expectedAt: new Date(body.expectedAt), status: 'scheduled',
    }));
  }

  // 送洗布草返回：晚于预期 2 小时记布草延迟事件
  @Post('deliveries/:id/arrive')
  async arrive(@Param('id') id: number) {
    const d = await this.deliveries.findOne({ where: { id } });
    if (!d) throw new NotFoundException('配送单不存在');
    if (d.status !== 'scheduled') throw new BadRequestException('该配送单已处理');
    const now = new Date();
    const late = now.getTime() > new Date(d.expectedAt).getTime() + 2 * 3600 * 1000;
    d.arrivedAt = now;
    d.status = late ? 'delayed' : 'delivered';
    await this.deliveries.save(d);
    const item = await this.items.findOne({ where: { item: d.item } });
    if (item) {
      item.inWash = Math.max(0, item.inWash - d.quantity);
      await this.items.save(item);
    }
    if (late) {
      await this.incidents.save(this.incidents.create({
        type: 'linen_delay', bookingId: null, roomId: null,
        description: `布草「${d.item}」${d.quantity} 件延迟送达（应 ${new Date(d.expectedAt).toLocaleString('zh-CN')} 前到），影响保洁换布`,
        status: 'open', cost: 0,
      }));
    }
    return d;
  }
}

// ================= 维修 =================
@Controller('maintenance')
export class MaintenanceController {
  constructor(
    @InjectRepository(MaintenanceTicket) private tickets: Repository<MaintenanceTicket>,
    @InjectRepository(Room) private rooms: Repository<Room>,
  ) {}

  @Get()
  list() {
    return this.tickets.find({ relations: ['room'], order: { id: 'DESC' } });
  }

  @Post()
  async create(@Body() body: { roomId: number; type: string; description: string; bookingId?: number; cost?: number }) {
    if (!body.roomId || !body.description) throw new BadRequestException('参数不完整');
    const t = await this.tickets.save(this.tickets.create({
      roomId: body.roomId, type: body.type || 'other', description: body.description,
      bookingId: body.bookingId || null, cost: body.cost || 0, status: 'open',
    }));
    await this.rooms.update(body.roomId, { status: 'maintenance' });
    return t;
  }

  @Post(':id/start')
  async start(@Param('id') id: number) {
    const t = await this.tickets.findOne({ where: { id } });
    if (!t) throw new NotFoundException('工单不存在');
    t.status = 'fixing';
    return this.tickets.save(t);
  }

  // 修复：房间转为待打扫，重新进入保洁链路
  @Post(':id/resolve')
  async resolve(@Param('id') id: number, @Body() body: { cost?: number }) {
    const t = await this.tickets.findOne({ where: { id } });
    if (!t) throw new NotFoundException('工单不存在');
    t.status = 'fixed';
    t.fixedAt = new Date();
    if (body.cost !== undefined) t.cost = body.cost;
    await this.tickets.save(t);
    await this.rooms.update(t.roomId, { status: 'dirty' });
    return t;
  }
}

// ================= 早餐 =================
@Controller('breakfast')
export class BreakfastController {
  constructor(
    @InjectRepository(Booking) private bookings: Repository<Booking>,
    @InjectRepository(BreakfastPrep) private preps: Repository<BreakfastPrep>,
    @InjectRepository(Incident) private incidents: Repository<Incident>,
  ) {}

  // 备餐计划：当早在住客人的份数与忌口汇总（入住日次日起到离店日当天供应）
  @Get('plan')
  async plan(@Query('date') date?: string) {
    const d = date || addDays(todayStr(), 1);
    const all = await this.bookings.find({ relations: ['room', 'roomType'] });
    // 转住合作民宿/退款的客人不在本店用早餐
    const serving = all.filter((b) => !['cancelled', 'relocated', 'refunded'].includes(b.status)
      && b.checkIn < d && b.checkOut >= d && b.breakfastCount > 0);
    const required = serving.reduce((s, b) => s + b.breakfastCount, 0);
    const prep = await this.preps.findOne({ where: { date: d } });
    return {
      date: d,
      supplyWindow: '07:00 - 09:30',
      required,
      prepared: prep?.preparedPortions ?? 0,
      status: prep?.status ?? 'planned',
      dietary: serving.filter((b) => b.dietaryNotes).map((b) => ({
        bookingCode: b.code, guest: b.guestName, room: b.room.code, notes: b.dietaryNotes, portions: b.breakfastCount,
      })),
      bookings: serving.map((b) => ({
        code: b.code, guest: b.guestName, room: b.room.code, portions: b.breakfastCount, dietary: b.dietaryNotes,
      })),
    };
  }

  // 厨房确认备餐量：不足则记早餐供应不足事件
  @Post('confirm')
  async confirm(@Body() body: { date: string; prepared: number; note?: string }) {
    if (!body.date || body.prepared === undefined) throw new BadRequestException('参数不完整');
    const plan = await this.plan(body.date);
    let prep = await this.preps.findOne({ where: { date: body.date } });
    if (!prep) prep = this.preps.create({ date: body.date });
    prep.requiredPortions = plan.required;
    prep.preparedPortions = body.prepared;
    prep.note = body.note || '';
    prep.confirmedAt = new Date();
    prep.status = body.prepared >= plan.required ? 'confirmed' : 'shortage';
    await this.preps.save(prep);
    if (prep.status === 'shortage') {
      await this.incidents.save(this.incidents.create({
        type: 'breakfast_shortage', bookingId: null, roomId: null,
        description: `${body.date} 早餐供应不足：需求 ${plan.required} 份，实际备餐 ${body.prepared} 份，缺口 ${plan.required - body.prepared} 份`,
        status: 'open', cost: 0,
      }));
    }
    return prep;
  }

  @Get('records')
  records() {
    return this.preps.find({ order: { date: 'DESC' } });
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([
    CleaningTask, Room, User, Booking, LinenItem, LinenDelivery, MaintenanceTicket, BreakfastPrep, Incident,
  ])],
  controllers: [CleaningController, LinenController, MaintenanceController, BreakfastController],
})
export class OpsModule {}
