#!/usr/bin/env python3
"""端到端验证脚本：覆盖登录、订单、房态、保洁、布草、早餐、事件、差评补偿、结算、复盘、调价。"""
import json, subprocess, sys

BASE = 'http://localhost:3000/api'
def call(method, path, token=None, body=None):
    cmd = ['curl', '-s', '-X', method, BASE + path, '-H', 'Content-Type: application/json']
    if token: cmd += ['-H', f'Authorization: Bearer {token}']
    if body is not None: cmd += ['-d', json.dumps(body)]
    out = subprocess.run(cmd, capture_output=True, text=True).stdout
    try: return json.loads(out)
    except Exception: return {'_raw': out}

ok = fail = 0
def check(name, cond, extra=''):
    global ok, fail
    if cond: ok += 1; print(f'  PASS {name} {extra}')
    else: fail += 1; print(f'  FAIL {name} {extra}')

login = call('POST', '/auth/login', body={'username': 'owner', 'password': '123456'})
T = login['token']
print('== 1. 认证 ==')
check('登录签发JWT', bool(T))
check('错误密码被拒', 'statusCode' in call('POST', '/auth/login', body={'username': 'owner', 'password': 'wrong'}))

print('== 2. 房态与库存 ==')
cal = call('GET', '/calendar?from=2026-10-03&to=2026-10-08', T)
check('日历 12间房', len(cal['rooms']) == 12)
inv = call('GET', '/inventory?from=2026-10-01&to=2026-10-08', T)
oversold = [(r['typeName'], d['date']) for r in inv for d in r['days'] if d['oversold']]
check('超卖被识别(10-01双床/10-04大床)', len(oversold) >= 2, str(oversold))

print('== 3. 订单全链路 ==')
bookings = call('GET', '/bookings', T)
check('19张种子订单', len(bookings) == 19)
b3 = [b for b in bookings if b['guestName'] == '王先生一家'][0]
detail = call('GET', f"/bookings/{b3['id']}", T)
check('订单详情含事件链', len(detail['incidents']) >= 2)  # ac_failure + bad_review
check('订单详情含保洁任务', detail['cleaningTask'] is not None)
check('订单详情含差评', detail['review'] and detail['review']['rating'] == 2)
check('结算含佣金/补偿/押金行', len(detail['settlement']['lines']) == 7)
s = detail['settlement']
check('结算净额=应收-佣金-补偿+押金扣留',
      abs(s['net'] - (s['gross'] - s['commission'] - s['compensation'] + s['deposit']['deducted'])) < 0.01)

# 规则校验：禁宠房型带宠物应被拒
rooms = call('GET', '/rooms', T)
channels = call('GET', '/channels', T)
r101 = [r for r in rooms if r['code'] == '101'][0]
ota = [c for c in channels if c['code'] == 'ota'][0]
bad = call('POST', '/bookings', T, {'roomId': r101['id'], 'channelId': ota['id'], 'guestName': '测试',
    'checkIn': '2026-10-10', 'checkOut': '2026-10-11', 'adults': 2, 'pets': 1})
check('禁宠房型带宠物被拒', bad.get('statusCode') == 400, bad.get('message', ''))
# 库存不足非强制应 409
full = call('POST', '/bookings', T, {'roomId': r101['id'], 'channelId': ota['id'], 'guestName': '测试超售',
    'checkIn': '2026-10-04', 'checkOut': '2026-10-05', 'adults': 2})
check('库存不足返回409', full.get('statusCode') == 409, full.get('message', ''))
# OTA 强制下单 → 超卖事件
forced = call('POST', '/bookings', T, {'roomId': r101['id'], 'channelId': ota['id'], 'guestName': '测试强推',
    'checkIn': '2026-10-04', 'checkOut': '2026-10-05', 'adults': 2, 'force': True})
check('OTA强制下单成功', forced.get('code', '').startswith('BK'))
check('强制单触发超卖事件', any(i['type'] == 'oversell' for i in forced.get('incidents', [])))
new_id = forced['id']
# 入住→临时加人→退房(延迟)→保洁任务
call('POST', f'/bookings/{new_id}/check-in', T)
eg = call('POST', f'/bookings/{new_id}/extra-guests', T, {'breakfastCount': 3})
check('临时加人重算早餐费', eg['breakfastFee'] == 3 * eg['nights'] * 38)
co = call('POST', f'/bookings/{new_id}/check-out', T, {'actualTime': '2026-10-05T14:00:00+08:00', 'dirtiness': 'heavy'})
check('延迟退房事件生成', any(i['type'] == 'late_checkout' for i in co['incidents']))
check('退房生成保洁任务', co['cleaningTask'] is not None and co['cleaningTask']['dirtiness'] == 'heavy')
check('押金已退', co['settlement']['deposit']['returned'] == 500)

print('== 4. 保洁与布草 ==')
plan = call('POST', '/cleaning/auto-schedule', T, {'date': '2026-10-03'})
check('智能排班产出方案', len(plan['plan']) >= 1)
check('排班含维修冲突告警', any(w for p in plan['plan'] for w in p['warnings']))
task_id = plan['plan'][0]['taskId']
call('POST', f'/cleaning/tasks/{task_id}/start', T)
stock_before = {s['item']: s['available'] for s in call('GET', '/linen/stock', T)}
call('POST', f'/cleaning/tasks/{task_id}/complete', T, {'linenUsed': 2})
stock_after = {s['item']: s['available'] for s in call('GET', '/linen/stock', T)}
check('完成保洁消耗布草', stock_after['床单'] == stock_before['床单'] - 2)
insp = call('POST', f'/cleaning/tasks/{task_id}/inspect', T)
check('保洁验收', insp['status'] == 'inspected')
# 布草延迟事件
dv = call('POST', '/linen/deliveries', T, {'item': '毛巾', 'quantity': 10, 'expectedAt': '2026-10-01T08:00:00+08:00'})
dv2 = call('POST', f"/linen/deliveries/{dv['id']}/arrive", T)
check('超时签收记为延迟', dv2['status'] == 'delayed')
inc = call('GET', '/incidents?type=linen_delay&status=open', T)
check('布草延迟事件生成', len(inc) >= 1)

print('== 5. 早餐 ==')
bp = call('GET', '/breakfast/plan?date=2026-10-04', T)
check('早餐需求按在住汇总', bp['required'] > 0, f"required={bp['required']}")
check('忌口汇总非空', len(bp['dietary']) >= 1)
conf = call('POST', '/breakfast/confirm', T, {'date': '2026-10-04', 'prepared': bp['required'] - 2})
check('备餐不足标记shortage', conf['status'] == 'shortage')
inc2 = call('GET', '/incidents?type=breakfast_shortage&status=open', T)
check('早餐不足事件生成', len(inc2) >= 1)

print('== 6. 差评与补偿 ==')
reviews = call('GET', '/reviews', T)
uncomp = [r for r in reviews if r['rating'] <= 3 and not r['compensated']]
check('存在待补偿差评', len(uncomp) >= 2)
comp = call('POST', f"/compensations/for-review/{uncomp[0]['id']}", T, {'type': 'voucher', 'amount': 120})
check('补偿券生成券码', comp.get('voucherCode', '').startswith('VC'))
used = call('POST', f"/compensations/{comp['id']}/use", T)
check('补偿券核销', used['status'] == 'used')
rv = call('POST', '/reviews', T, {'bookingId': new_id, 'rating': 2, 'category': 'service', 'content': '测试差评'})
check('新差评自动生成事件', rv.get('id') is not None)
inc3 = call('GET', '/incidents?type=bad_review&status=open', T)
check('差评事件在链路中', len(inc3) >= 1)

print('== 7. 结算 ==')
st = call('GET', '/settlements?from=2026-10-01&to=2026-10-08', T)
check('结算列表非空', len(st['list']) >= 15)
check('合计=各行求和', abs(st['totals']['net'] - sum(x['net'] for x in st['list'])) < 0.05)
ota_rows = [x for x in st['list'] if x['channelCode'] == 'ota' and not x.get('channelSettlementBlocked')]
check('OTA佣金=房费15%（转住单除外）', all(abs(x['commission'] - [l['amount'] for l in x['lines'] if l['label'].startswith('房费')][0] * 0.15) < 0.05 for x in ota_rows))
# 历史转住单（吴女士，10-01 庭院双床房）按合作方价结算：渠道佣金为 0 且带防错提示
bk18_settle = [x for x in st['list'] if x['guestName'] == '吴女士']
check('历史转住单存在', len(bk18_settle) == 1)
if bk18_settle:
    bs = bk18_settle[0]
    check('转住单渠道不再按原房型结算(佣金0+防错标记)', bs['commission'] == 0 and bs['channelSettlementBlocked'] is True, bs.get('settlementNote', ''))
    check('转住单含合作方代付行', any('代付' in l['label'] and abs(abs(l['amount']) - 520) < 0.01 for l in bs['lines']))
    check('转住单记录合作方距离/满意度/结算方式', bool(bs['partner']) and bs['partner']['distanceKm'] == 0.8 and bs['partner']['satisfaction'] == 3 and bs['partner']['method'] == 'monthly')

print('== 8. 复盘与调价 ==')
dash = call('GET', '/analytics/dashboard?from=2026-09-28&to=2026-10-08', T)
check('看板KPI完整', all(k in dash['kpi'] for k in ['occupancy', 'adr', 'revpar', 'compensationCost']))
check('差评归因四类可查', len(dash['reviewByCategory']) >= 3)
profit = call('GET', '/analytics/profit?from=2026-10-01&to=2026-10-08', T)
check('分渠道利润', len(profit['byChannel']) == 4)
check('分房型利润', len(profit['byRoomType']) == 4)
check('问题归类三类', {c['type'] for c in profit['classification']} == {'价格策略问题', '履约能力问题', '个别客诉'})
adj = call('GET', '/analytics/adjustment', T)
check('调价建议产出', len(adj['rows']) == 4)
t1 = [r for r in adj['rows'] if r['typeName'] == '山景大床房'][0]
check('超卖房型建议下调可售', t1['adjustedSellable'] < t1['total'], f"{t1['adjustedSellable']}/{t1['total']}")
applied = call('POST', '/analytics/apply-adjustment', T, {'from': '2026-12-31', 'to': '2027-01-02'})
check('调价应用成功', applied.get('ok') is True)
inv2 = call('GET', '/inventory?from=2026-12-31&to=2027-01-02', T)
t1row = [r for r in inv2 if r['typeName'] == '山景大床房'][0]
check('新周期可售=调整值', t1row['days'][0]['sellable'] == t1['adjustedSellable'])

print('== 9. 超卖换房补偿 ==')
cases = call('GET', '/oversells/cases', T)
check('种子含两起超卖案件', len(cases) == 2, str([(c['code'], c['status']) for c in cases]))
open_case = [c for c in cases if c['code'] == 'OS26100401'][0]
hist_case = [c for c in cases if c['code'] == 'OS26100101'][0]
check('历史案件已解决且成本¥520', hist_case['status'] == 'resolved' and float(hist_case['totalCompensationCost']) == 520)
check('开放案件责任为OTA延迟同步', open_case['channelResponsibility'] == 'ota_delayed_sync')
oc = call('GET', f"/oversells/cases/{open_case['id']}", T)
check('案件含4位冲突客人(3保留+1待方案)', len(oc['items']) == 4
      and len([i for i in oc['items'] if i['status'] == 'kept']) == 3
      and len([i for i in oc['items'] if i['status'] == 'pending']) == 1)
displaced = [i for i in oc['items'] if i['status'] == 'pending'][0]
check('评分末位为谢女士(银卡/最晚订)', displaced['booking']['guestName'] == '谢女士' and displaced['rank'] == 4)
retained = [i for i in oc['items'] if i['status'] == 'kept']
check('白金客人许先生排名第1保留原房', retained[0]['booking']['guestName'] == '许先生' and retained[0]['rank'] == 1)
check('评分含四因子(下单/到店/价值/会员)', {d['label'] for d in displaced['scoreDetails']} == {'下单时间', '到店时间', '订单价值', '会员等级'})
dup = call('POST', '/oversells/detect', T, {'roomTypeId': oc['roomType']['id'], 'date': '2026-10-04', 'delayMin': 28})
check('重复检测幂等不重建案件', dup.get('id') == open_case['id'])
notover = call('POST', '/oversells/detect', T, {'roomTypeId': oc['roomType']['id'], 'date': '2026-10-10', 'delayMin': 10})
check('未超卖日期拒绝建案', notover.get('statusCode') == 400)
prooms = call('GET', '/partners/rooms?date=2026-10-04', T)
zx = [p for p in prooms if p['partner']['name'] == '竹溪民宿' and p['roomName'] == '观景大床房'][0]
check('合作方房源报价¥620且有余量', float(zx['partnerPrice']) == 620 and zx['remaining'] == 1)
inv_before = call('GET', '/inventory?from=2026-10-04&to=2026-10-04', T)
t1_before = [r for r in inv_before if r['typeName'] == '山景大床房'][0]['days'][0]
call('POST', f"/oversells/items/{displaced['id']}/propose", T,
     {'option': 'partner', 'partnerRoomId': zx['id'], 'compensationAmount': 0})
dec = call('POST', f"/oversells/items/{displaced['id']}/decide", T, {'accepted': True, 'response': '愿意转住竹溪民宿'})
acc_item = [i for i in dec['items'] if i['id'] == displaced['id']][0]
check('客人接受转住', acc_item['status'] == 'accepted' and acc_item['option'] == 'partner')
check('转住成本=合作方价×晚数¥620', float(acc_item['platformCost']) == 620 and float(acc_item['partnerPrice']) == 620)
check('结算防错提示已生成', '渠道不得再按原房型结算' in acc_item['settlementGuard'])
bk14 = call('GET', f"/bookings/{displaced['bookingId']}", T)
check('原订单保留超卖原因/渠道责任/补偿成本', bool(bk14['oversellReason']) and bk14['channelResponsibility'] == 'ota_delayed_sync' and float(bk14['oversellCompensationCost']) == 620)
check('原订单改为合作方价结算口径', bk14['settlementBasis'] == 'partner_settled')
inv_after = call('GET', '/inventory?from=2026-10-04&to=2026-10-04', T)
t1_after = [r for r in inv_after if r['typeName'] == '山景大床房'][0]['days'][0]
check('转住后原房型释放1间', t1_after['booked'] == t1_before['booked'] - 1, f"{t1_before['booked']}->{t1_after['booked']}")
prooms2 = call('GET', '/partners/rooms?date=2026-10-04', T)
zx2 = [p for p in prooms2 if p['id'] == zx['id']][0]
check('合作房量被占用(余量0)', zx2['remaining'] == 0 and zx2['sold'] == 1)
sat = call('POST', f"/oversells/items/{displaced['id']}/satisfaction", T, {'rating': 4, 'note': '民宿干净，接送及时'})
check('满意度已登记', any(float(i['guestSatisfaction']) == 4 for i in sat['items'] if i['id'] == displaced['id']))
oc2 = call('GET', f"/oversells/cases/{open_case['id']}", T)
check('全部处理完案件关闭', oc2['status'] == 'resolved' and float(oc2['totalCompensationCost']) == 620)
deny = call('POST', f"/bookings/{displaced['bookingId']}/check-in", T)
check('转住单拒绝本店入住', deny.get('statusCode') == 400)

# 场景二：升级房（10-07 山景大床房，4 单）
t1_id = [t for t in call('GET', '/room-types', T) if t['name'] == '山景大床房'][0]['id']
rooms_all = call('GET', '/rooms', T)
r101, r102, r103 = [[r for r in rooms_all if r['code'] == c][0]['id'] for c in ('101', '102', '103')]
for idx, rid in enumerate([r101, r102, r103, r101]):
    call('POST', '/bookings', T, {'roomId': rid, 'channelId': ota['id'], 'guestName': f'测试升{idx}',
         'checkIn': '2026-10-07', 'checkOut': '2026-10-08', 'adults': 2, 'force': idx == 3,
         'memberLevel': 'gold', 'estimatedArrival': '2026-10-07T15:00:00+08:00'})
cu = call('POST', '/oversells/detect', T, {'roomTypeId': t1_id, 'date': '2026-10-07', 'delayMin': 15})
check('升级场景建案成功', cu.get('id') is not None and cu['status'] == 'open', str(cu)[:120])
disp_u = [i for i in cu['items'] if i['status'] == 'pending'][0]
check('存在更高价位升级空房', len(disp_u['upgradeOptions']) >= 1, str([o['roomCode'] for o in disp_u['upgradeOptions']]))
up = disp_u['upgradeOptions'][0]
pu = call('POST', f"/oversells/items/{disp_u['id']}/propose", T,
          {'option': 'upgrade', 'upgradeRoomId': up['roomId'], 'compensationAmount': 0, 'surcharge': 0})
iu = [i for i in pu['items'] if i['id'] == disp_u['id']][0]
check('升级平台吸收差价>0', abs(float(iu['platformCost']) - (float(iu['upgradePrice']) - float(iu['booking']['roomFee']))) < 0.01)
du = call('POST', f"/oversells/items/{disp_u['id']}/decide", T, {'accepted': True})
iu2 = [i for i in du['items'] if i['id'] == disp_u['id']][0]
check('升级接受后订单换到新房', iu2['status'] == 'accepted')
bu = call('GET', f"/bookings/{disp_u['bookingId']}", T)
check('订单房间已升级且保留超卖标记', bu['roomId'] == up['roomId'] and bool(bu['oversellReason']))

# 场景三：退款补偿（10-08 庭院双床房，4 单）
t2_id = [t for t in call('GET', '/room-types', T) if t['name'] == '庭院双床房'][0]['id']
r201, r202, r203 = [[r for r in rooms_all if r['code'] == c][0]['id'] for c in ('201', '202', '203')]
for idx, rid in enumerate([r201, r202, r203, r203]):
    call('POST', '/bookings', T, {'roomId': rid, 'channelId': ota['id'], 'guestName': f'测试退{idx}',
         'checkIn': '2026-10-08', 'checkOut': '2026-10-09', 'adults': 2, 'breakfastCount': 2, 'force': idx == 3})
cr = call('POST', '/oversells/detect', T, {'roomTypeId': t2_id, 'date': '2026-10-08', 'delayMin': 12})
disp_r = [i for i in cr['items'] if i['status'] == 'pending'][0]
bad_prop = call('POST', f"/oversells/items/{disp_r['id']}/propose", T, {'option': 'refund', 'compensationAmount': 0})
check('退款金额为0被拒', bad_prop.get('statusCode') == 400)
call('POST', f"/oversells/items/{disp_r['id']}/propose", T, {'option': 'refund', 'compensationType': 'refund', 'compensationAmount': 300})
dr = call('POST', f"/oversells/items/{disp_r['id']}/decide", T, {'accepted': True, 'response': '接受退款自行解决'})
ir = [i for i in dr['items'] if i['id'] == disp_r['id']][0]
check('退款方案接受且案件关闭', ir['status'] == 'accepted' and dr['status'] == 'resolved')
br = call('GET', f"/bookings/{disp_r['bookingId']}", T)
check('退款订单已取消并保留超卖原因', br['status'] == 'cancelled' and bool(br['oversellReason']) and br['channelResponsibility'] == 'ota_delayed_sync')
comps_r = call('GET', '/compensations', T)
check('退款补偿已落补偿账', any(c['bookingId'] == disp_r['bookingId'] and abs(float(c['amount']) - 300) < 0.01 and c['type'] == 'refund' for c in comps_r))

# 场景四：客人拒绝后可重新出方案（10-09 山景大床房）
for idx, rid in enumerate([r101, r102, r103, r102]):
    call('POST', '/bookings', T, {'roomId': rid, 'channelId': ota['id'], 'guestName': f'测试拒{idx}',
         'checkIn': '2026-10-09', 'checkOut': '2026-10-10', 'adults': 2, 'force': idx == 3})
cj = call('POST', '/oversells/detect', T, {'roomTypeId': t1_id, 'date': '2026-10-09', 'delayMin': 9})
disp_j = [i for i in cj['items'] if i['status'] == 'pending'][0]
call('POST', f"/oversells/items/{disp_j['id']}/propose", T, {'option': 'refund', 'compensationAmount': 100})
dj = call('POST', f"/oversells/items/{disp_j['id']}/decide", T, {'accepted': False, 'response': '退款太少'})
ij = [i for i in dj['items'] if i['id'] == disp_j['id']][0]
check('客人拒绝被记录且可再提案', ij['status'] == 'declined')
pj2 = call('POST', f"/oversells/items/{disp_j['id']}/propose", T, {'option': 'refund', 'compensationAmount': 400})
check('拒绝后可重新出方案', any(i['id'] == disp_j['id'] and i['status'] == 'proposed' for i in pj2['items']))

# 渠道同步策略：复盘收紧
pols = call('GET', '/oversells/sync-policies', T)
ota_pol = [p for p in pols if p['channelCode'] == 'ota'][0]
upd = call('POST', f"/oversells/sync-policies/{ota_pol['channelId']}", T,
           {'syncIntervalMin': 3, 'safetyBuffer': 1, 'mode': 'manual', 'note': '两次延迟同步，改人工确认放房'})
check('同步策略已收紧(3分钟/缓冲1/人工)', upd['syncIntervalMin'] == 3 and upd['safetyBuffer'] == 1 and upd['mode'] == 'manual')

# 超卖复盘
review = call('GET', '/analytics/oversell-review', T)
check('复盘统计5起案件(2种子+3新场景)', review['totals']['cases'] == 5, str(review['totals']))
check('复盘转住2/升级1/退款1', (review['totals']['partner'], review['totals']['upgrade'], review['totals']['refund']) == (2, 1, 1), str(review['totals']))
ota_sum = [c for c in review['byChannel'] if c['channelCode'] == 'ota'][0]
check('复盘含OTA渠道责任与策略建议', ota_sum['cases'] == 5 and '收紧' in ota_sum['suggestion']['text'])
hist_review = [c for c in review['cases'] if c['code'] == 'OS26100101'][0]
check('复盘保留合作方价格/距离/满意度/结算方式',
      hist_review['partnerTransfers'][0]['pricePerNight'] == 520 and hist_review['partnerTransfers'][0]['distanceKm'] == 0.8
      and hist_review['partnerTransfers'][0]['satisfaction'] == 3 and hist_review['partnerTransfers'][0]['method'] == 'monthly')

print(f'\n结果: {ok} 通过, {fail} 失败')
sys.exit(1 if fail else 0)
