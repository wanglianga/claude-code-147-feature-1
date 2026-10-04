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
# 10-01 双床房超卖已通过转住合作民宿处置（库存回落），当前仅 10-04 山景大床房仍超卖
check('超卖被识别(10-04大床待处置)', ('山景大床房', '2026-10-04') in oversold, str(oversold))
check('10-01超卖转住后库存已回落', ('庭院双床房', '2026-10-01') not in oversold)

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
ota_rows = [x for x in st['list'] if x['channelCode'] == 'ota']
check('OTA佣金=房费15%', all(abs(x['commission'] - x['lines'][0]['amount'] * 0.15) < 0.05 for x in ota_rows))

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
cases = call('GET', '/oversell/cases', T)
check('种子含2张处置工单', len(cases) == 2, str([(c['code'], c['status']) for c in cases]))
hist = [c for c in cases if c['code'] == 'OS261001'][0]
opn = [c for c in cases if c['code'] == 'OS261004'][0]
check('历史工单为合作民宿转住已接受', hist['resolutionType'] == 'partner' and hist['status'] == 'accepted')
check('历史工单记录合作价/距离/结算方式', hist['partnerPricePerNight'] == 680
      and hist['distanceKm'] == 1.2 and hist['partnerSettlementType'] == 'monthly')
check('历史工单渠道责任在OTA(电话单受害)', hist['responsibleChannelId'] != hist['channelId'])
check('历史工单含补偿成本/合作方成本/索赔', hist['compensationCost'] == 200
      and hist['partnerCost'] == 680 and hist['channelClaimAmount'] == 880
      and hist['channelClaimStatus'] == 'settled')
check('历史工单客人满意度已记录', hist['guestSatisfaction'] == 4)
# 历史工单原订单：转住状态 + 结算按合作价锁定
bk18 = call('GET', f"/bookings/{hist['bookingId']}", T)
check('吴女士订单状态=转住合作民宿', bk18['status'] == 'relocated' and bk18['relocatedToPartner'])
check('转住结算含合作民宿房费支出行', any('合作民宿房费支出' in x['label'] for x in bk18['settlement']['lines']))
check('转住结算含索赔到账行', any(x['label'] == '渠道超卖索赔到账' and x['amount'] == 880 for x in bk18['settlement']['lines']))
check('结算口径已锁定且带合作方信息', bk18['settlement']['oversell']['settlementLocked'] is True
      and bk18['settlement']['oversell']['partnerName'] == '竹溪小院')
# 房态日历：203 房 10-01 仅剩 OTA 黄先生，吴女士转住后不再占用本店房态
cal2 = call('GET', '/calendar?from=2026-10-01&to=2026-10-02', T)
cell203 = [c for r in cal2['rooms'] if r['code'] == '203' for c in r['cells'] if c['date'] == '2026-10-01'][0]
check('转住单不占用本店房态(203仅剩OTA客)', cell203['guest'] == '黄先生', str(cell203))

# 合作民宿与同步策略
partners = call('GET', '/oversell/partners', T)
check('合作民宿2家', len(partners) == 2 and all(k in partners[0] for k in ['pricePerNight', 'distanceKm', 'settlementType']))
policies = call('GET', '/oversell/sync-policies', T)
ota_pol = [p for p in policies if p['channelCode'] == 'ota'][0]
check('OTA同步策略60分钟无缓冲(超卖根因)', ota_pol['syncIntervalMin'] == 60 and ota_pol['bufferRooms'] == 0)

# 待处理工单：四因子打分与方案
od = call('GET', f"/oversell/cases/{opn['id']}", T)
check('工单方案含三选项', all(k in od['plan']['options'] for k in ['upgrade', 'partner', 'refund']))
check('打分四因子齐全', all(k in od['plan']['factors'] for k in ['orderedAt', 'etaTime', 'memberLevel', 'roomTypeValue']))
rank = {r['bookingId']: r for r in od['plan']['ranked']}
cao_id = [b for b in bookings if b['guestName'] == '曹先生'][0]['id']
# 谢女士(铂金/到店更早)综合得分高于曹先生，但同房(101)保留规则优先 → 曹先生留原房，谢女士作为高价值客人升级更好套房
check('会员+到店提升谢女士综合分', rank[opn['bookingId']]['score'] > rank[cao_id]['score'],
      f"{rank[opn['bookingId']]['score']} vs {rank[cao_id]['score']}")
check('保留方为同房另一单(曹先生)', od['plan']['factors']['keeper']['bookingId'] == cao_id)
check('因子明细完整(下单/到店/会员/房值)', all(k in rank[cao_id] for k in ['orderPts', 'etaPts', 'memberPts', 'valuePts']))
check('升级房仅含更高价值空房', all(u['newFee'] > u['upgradeCost'] >= 0 for u in od['plan']['options']['upgrade']))
check('退款方案=原单全额', od['plan']['options']['refund']['refundAmount'] == od['booking']['totalAmount'])
check('重复生成工单被拒', call('POST', '/oversell/cases', T, {'incidentId': od['incidentId']}).get('statusCode') == 400)

# 方案一：店内升级房（谢女士 101 → 401 Loft），差价平台承担+补偿券
inv_before = {(r['typeName'], d['date']): d for r in
              call('GET', '/inventory?from=2026-10-04&to=2026-10-04', T) for d in r['days']}
t1_before = inv_before[('山景大床房', '2026-10-04')]['booked']
t4_before = inv_before[('Loft观景套房', '2026-10-04')]['booked']
upg_room = od['plan']['options']['upgrade'][0]
arr = call('POST', f"/oversell/cases/{opn['id']}/arrange", T, {
    'option': 'upgrade', 'roomId': upg_room['roomId'],
    'compensationType': 'voucher', 'compensationAmount': 150,
    'channelResponsibility': 'channel'})
check('升级方案已安排', arr['status'] == 'arranged' and arr['resolutionType'] == 'upgrade')
check('升级成本=差价+善意补偿', arr['compensationCost'] == upg_room['upgradeCost'] + 150)
exp_claim1 = arr['compensationCost'] + round(od['booking']['roomFee'] * ota['commissionRate'], 2)
check('渠道索赔=损失+渠道佣金自动计算', abs(arr['channelClaimAmount'] - exp_claim1) < 0.01,
      f"{arr['channelClaimAmount']} vs {exp_claim1}")
acc = call('POST', f"/oversell/cases/{opn['id']}/accept", T, {'satisfaction': 5, 'compensationType': 'voucher'})
check('客人接受后工单锁定', acc['status'] == 'accepted' and acc['settlementLocked'] is True)
check('超卖事件已关闭并记录原因/成本/责任', acc['incident']['status'] == 'resolved'
      and acc['incident']['cost'] == arr['compensationCost'] and 'OTA平台全责' in acc['incident']['resolution'],
      acc['incident']['resolution'])
inv_after = {(r['typeName'], d['date']): d for r in
             call('GET', '/inventory?from=2026-10-04&to=2026-10-04', T) for d in r['days']}
check('升级后原房型库存回落1', inv_after[('山景大床房', '2026-10-04')]['booked'] == t1_before - 1)
check('升级后新房型库存增加1', inv_after[('Loft观景套房', '2026-10-04')]['booked'] == t4_before + 1)
bk14d = call('GET', f"/bookings/{opn['bookingId']}", T)
check('订单换房到升级房但保留原房型结算', bk14d['room']['code'] == upg_room['roomCode'] and bk14d['roomType']['name'] == '山景大床房', f"{bk14d['room']['code']}")
check('升级补偿(差价+券)已入账', bk14d['settlement']['compensation'] == upg_room['upgradeCost'] + 150)
# 索赔到账后净额勾稽：渠道全责 → 净额回到应收水平
claim = call('POST', f"/oversell/cases/{opn['id']}/claim", T, {'status': 'settled'})
check('索赔到账状态更新', claim['channelClaimStatus'] == 'settled')
bk14d2 = call('GET', f"/bookings/{opn['bookingId']}", T)
st14 = bk14d2['settlement']
check('索赔到账计入结算行', any(x['label'] == '渠道超卖索赔到账' for x in st14['lines']))
check('渠道全责下净额=应收(损失全部追回)',
      abs(st14['net'] - st14['gross']) < 0.01, f"net={st14['net']} gross={st14['gross']}")

# 方案二：强制再超卖一单 → 合作民宿转住
forced2 = call('POST', '/bookings', T, {'roomId': r101['id'], 'channelId': ota['id'], 'guestName': '转住测试',
    'checkIn': '2026-10-04', 'checkOut': '2026-10-05', 'adults': 2, 'force': True,
    'memberLevel': 'silver', 'etaTime': '2026-10-04T16:00:00'})
check('转住测试单触发超卖事件', any(i['type'] == 'oversell' for i in forced2.get('incidents', [])))
oc2 = call('POST', '/oversell/cases', T, {'bookingId': forced2['id']})
check('按bookingId生成工单成功', oc2.get('code', '').startswith('OS'))
arr2 = call('POST', f"/oversell/cases/{oc2['id']}/arrange", T, {
    'option': 'partner', 'partnerId': partners[0]['id'],
    'compensationType': 'cash', 'compensationAmount': 80, 'channelResponsibility': 'shared'})
check('合作民宿方案已安排(记录价格/距离/结算方式)',
      arr2['resolutionType'] == 'partner' and arr2['partnerPricePerNight'] == 680
      and arr2['distanceKm'] == 1.2 and arr2['partnerSettlementType'] == 'monthly')
check('合作方成本=合作价×晚数', arr2['partnerCost'] == 680)
check('共担责任索赔=损失一半',
      abs(arr2['channelClaimAmount'] - (680 + 80 + round(forced2['roomFee'] * ota['commissionRate'], 2)) / 2) < 0.01,
      str(arr2['channelClaimAmount']))
acc2 = call('POST', f"/oversell/cases/{oc2['id']}/accept", T, {'satisfaction': 4})
fb2 = call('GET', f"/bookings/{forced2['id']}", T)
check('转住后订单挂钩合作方', fb2['status'] == 'relocated'
      and fb2['relocatedToPartner']['name'] == partners[0]['name'])
check('转住结算锁定合作价不按原房型', fb2['settlement']['oversell']['partnerCost'] == 680
      and fb2['settlement']['oversell']['settlementLocked'] is True)
inv_partner = [d for r in call('GET', '/inventory?from=2026-10-04&to=2026-10-04', T)
               for d in r['days'] if r['typeName'] == '山景大床房'][0]['booked']
check('转住后库存回落到升级处置后水平', inv_partner == t1_before - 1)

# 方案三：再超卖一单 → 全额退款
forced3 = call('POST', '/bookings', T, {'roomId': r101['id'], 'channelId': ota['id'], 'guestName': '退款测试',
    'checkIn': '2026-10-04', 'checkOut': '2026-10-05', 'adults': 2, 'force': True})
oc3 = call('POST', '/oversell/cases', T, {'bookingId': forced3['id']})
arr3 = call('POST', f"/oversell/cases/{oc3['id']}/arrange", T, {'option': 'refund', 'channelResponsibility': 'channel'})
check('退款方案金额=原单总额', arr3['compensationCost'] == forced3['totalAmount'])
acc3 = call('POST', f"/oversell/cases/{oc3['id']}/accept", T, {'satisfaction': 3})
fb3 = call('GET', f"/bookings/{forced3['id']}", T)
check('退款后订单状态=refunded且押金已退', fb3['status'] == 'refunded' and fb3['depositReturned'] == 500)
st_list = call('GET', '/settlements?from=2026-10-01&to=2026-10-08', T)
check('退款单不进结算中心', all(x['bookingId'] != forced3['id'] for x in st_list['list']))
check('转住单在结算中带合作方支出', any(x['bookingId'] == forced2['id'] and x['partnerCost'] == 680 for x in st_list['list']))

# 店主复盘：收紧 OTA 同步策略
upd = call('PUT', f"/oversell/sync-policies/{ota['id']}", T,
           {'syncIntervalMin': 10, 'bufferRooms': 1, 'pushOnChange': True, 'note': '10-01/10-04超卖后收紧为10分钟+1间缓冲房'})
check('同步策略可调整', upd.get('ok') is True)
ota_pol2 = [p for p in call('GET', '/oversell/sync-policies', T) if p['channelCode'] == 'ota'][0]
check('OTA策略已收紧', ota_pol2['syncIntervalMin'] == 10 and ota_pol2['bufferRooms'] == 1)
review = call('GET', '/oversell/review', T)
check('超卖复盘汇总工单/成本/索赔', review['total'] == 4 and review['accepted'] == 4
      and review['totalClaim'] > 0, str((review['total'], review['accepted'])))
ota_row = [r for r in review['byChannel'] if r['channelCode'] == 'ota'][0]
check('复盘分渠道含索赔到账(历史880+新处置)', ota_row['claimSettled'] >= 880, str(ota_row['claimSettled']))
pstat = review['partnerStats']
check('合作方评估含价格/距离/满意度/结算', any(p['name'] == '竹溪小院' and p['avgSatisfaction'] >= 4
      and 'monthly' in p['settlementTypes'] and p['cost'] >= 680 for p in pstat), str(pstat))
resp_set = {r['responsibility'] for r in review['responsibility']}
check('责任分布含渠道全责与双方共担', {'channel', 'shared'} <= resp_set, str(resp_set))
# 复盘利润含合作方成本与索赔冲减
profit2 = call('GET', '/analytics/profit?from=2026-10-01&to=2026-10-08', T)
check('复盘成本含合作民宿房费', 'partnerRelocation' in profit2['serviceSegments']['costs']
      and profit2['serviceSegments']['costs']['partnerRelocation'] >= 1360)
check('复盘成本含渠道索赔到账冲减', profit2['serviceSegments']['costs']['channelClaimRecovered'] >= 880)

print(f'\n结果: {ok} 通过, {fail} 失败')
sys.exit(1 if fail else 0)
