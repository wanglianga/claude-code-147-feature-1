import {
  BadRequestException, Body, Controller, Get, Module, Param, Patch, Post, Query,
} from '@nestjs/common';
import { InjectRepository, TypeOrmModule } from '@nestjs/typeorm';
import { Between, LessThanOrEqual, MoreThan, Repository } from 'typeorm';
import {
  Booking, Channel, DailyInventory, DailyPrice, Room, RoomType,
} from '../entities';
import { addDays, diffDays, eachDay, todayStr } from '../common/util';

@Controller()
export class CatalogController {
  constructor(
    @InjectRepository(RoomType) private types: Repository<RoomType>,
    @InjectRepository(Room) private rooms: Repository<Room>,
    @InjectRepository(Channel) private channels: Repository<Channel>,
    @InjectRepository(DailyPrice) private prices: Repository<DailyPrice>,
    @InjectRepository(DailyInventory) private inventory: Repository<DailyInventory>,
    @InjectRepository(Booking) private bookings: Repository<Booking>,
  ) {}

  @Get('room-types')
  roomTypes() {
    return this.types.find({ order: { id: 'ASC' } });
  }

  @Get('rooms')
  roomList() {
    return this.rooms.find({ relations: ['roomType'], order: { code: 'ASC' } });
  }

  @Patch('rooms/:id/status')
  async setRoomStatus(@Param('id') id: number, @Body() body: { status: string }) {
    const room = await this.rooms.findOne({ where: { id } });
    if (!room) throw new BadRequestException('房间不存在');
    room.status = body.status;
    return this.rooms.save(room);
  }

  @Get('channels')
  channelList() {
    return this.channels.find({ order: { id: 'ASC' } });
  }

  // 房态日历：房间 × 日期，含订单占用、保洁状态、当日价格
  @Get('calendar')
  async calendar(@Query('from') from?: string, @Query('to') to?: string) {
    const start = from || todayStr();
    const end = to || addDays(start, 14);
    const rooms = await this.rooms.find({ relations: ['roomType'], order: { code: 'ASC' } });
    const bookings = await this.bookings.find({
      where: { checkIn: LessThanOrEqual(end), checkOut: MoreThan(start) },
      relations: ['channel'],
    });
    const prices = await this.prices.find({ where: { date: Between(start, end) } });
    const priceMap = new Map(prices.map((p) => [`${p.roomTypeId}|${p.date}`, Number(p.price)]));
    const dates = eachDay(start, addDays(end, 1));
    // 转住合作民宿/超卖退款单已释放本店房间，不再占用房态
    const active = bookings.filter((b) => !['cancelled', 'relocated', 'refunded'].includes(b.status));
    return {
      from: start,
      to: end,
      dates,
      rooms: rooms.map((r) => ({
        id: r.id,
        code: r.code,
        status: r.status,
        type: r.roomType.name,
        typeId: r.roomTypeId,
        cells: dates.map((d) => {
          const b = active.find((x) => x.roomId === r.id && x.checkIn <= d && x.checkOut > d);
          return {
            date: d,
            state: b ? (b.status === 'checked_in' ? 'inhouse' : 'booked') : 'free',
            bookingId: b?.id || null,
            bookingCode: b?.code || null,
            guest: b?.guestName || null,
            channel: b?.channel?.name || null,
            price: priceMap.get(`${r.roomTypeId}|${d}`) ?? Number(r.roomType.basePrice),
          };
        }),
      })),
    };
  }

  // 库存：各房型每日 总量/可售/已订
  @Get('inventory')
  async inventoryList(@Query('from') from?: string, @Query('to') to?: string) {
    const start = from || todayStr();
    const end = to || addDays(start, 14);
    const types = await this.types.find({ order: { id: 'ASC' } });
    const rows = await this.inventory.find({ where: { date: Between(start, end) } });
    const map = new Map(rows.map((r) => [`${r.roomTypeId}|${r.date}`, r]));
    const dates = eachDay(start, addDays(end, 1));
    return types.map((t) => ({
      typeId: t.id,
      typeName: t.name,
      days: dates.map((d) => {
        const r = map.get(`${t.id}|${d}`);
        return {
          date: d,
          total: r?.total ?? 0,
          sellable: r?.sellable ?? 0,
          booked: r?.booked ?? 0,
          available: (r?.sellable ?? 0) - (r?.booked ?? 0),
          oversold: r ? r.booked > r.total : false,
        };
      }),
    }));
  }

  // 生成/补齐某日期区间的库存与价格（调价应用、种子数据都会用）
  @Post('inventory/generate')
  async generate(@Body() body: { from: string; to: string; sellableByType?: Record<number, number> }) {
    if (!body.from || !body.to || diffDays(body.to, body.from) < 0) {
      throw new BadRequestException('日期区间不合法');
    }
    const types = await this.types.find();
    const rooms = await this.rooms.find();
    for (const t of types) {
      const total = rooms.filter((r) => r.roomTypeId === t.id).length;
      for (const d of eachDay(body.from, addDays(body.to, 1))) {
        let inv = await this.inventory.findOne({ where: { roomTypeId: t.id, date: d } });
        if (!inv) {
          inv = this.inventory.create({ roomTypeId: t.id, date: d, total, sellable: total, booked: 0 });
        }
        inv.total = total;
        const override = body.sellableByType?.[t.id];
        if (override !== undefined) inv.sellable = Math.min(override, total);
        await this.inventory.save(inv);
        const hasPrice = await this.prices.findOne({ where: { roomTypeId: t.id, date: d } });
        if (!hasPrice) {
          await this.prices.save(this.prices.create({ roomTypeId: t.id, date: d, price: Number(t.basePrice) }));
        }
      }
    }
    return { ok: true };
  }
}

@Module({
  imports: [TypeOrmModule.forFeature([RoomType, Room, Channel, DailyPrice, DailyInventory, Booking])],
  controllers: [CatalogController],
})
export class CatalogModule {}
