import React, { useEffect, useState } from 'react';
import {
  Alert, Button, Card, Col, DatePicker, Descriptions, Drawer, Form, Input, InputNumber,
  Modal, Popconfirm, Radio, Rate, Row, Select, Space, Statistic, Table, Tabs, Tag,
  Timeline, message,
} from 'antd';
import dayjs from 'dayjs';
import api, {
  MEMBER_LEVELS, OVERSELL_CASE_STATUS, OVERSELL_ITEM_STATUS, OVERSELL_OPTIONS,
  SETTLE_METHODS, SYNC_MODES,
} from '../api';

export default function Oversell() {
  return (
    <Card title="渠道超卖 · 换房补偿">
      <Tabs items={[
        { key: 'cases', label: '超卖案件', children: <CasesPane /> },
        { key: 'partners', label: '同村合作民宿', children: <PartnersPane /> },
        { key: 'policies', label: '渠道同步策略', children: <PoliciesPane /> },
        { key: 'review', label: '超卖复盘', children: <ReviewPane /> },
      ]} />
    </Card>
  );
}

// ============ 案件 ============
function CasesPane() {
  const [cases, setCases] = useState([]);
  const [roomTypes, setRoomTypes] = useState([]);
  const [caseId, setCaseId] = useState(null);
  const [detectOpen, setDetectOpen] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    const [cs, ts] = await Promise.all([api.get('/oversells/cases'), api.get('/room-types')]);
    setCases(cs); setRoomTypes(ts);
  };
  useEffect(() => { load(); }, []);

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => setDetectOpen(true)}>检测超卖并生成案件</Button>
        <span style={{ color: '#888' }}>OTA 延迟同步致同房重复售出时，按房型+入住日检测；平台依据下单/到店/订单价值/会员评分给出取舍</span>
      </Space>
      <Table dataSource={cases} rowKey="id" pagination={false} columns={[
        { title: '案件号', dataIndex: 'code', width: 120 },
        { title: '冲突日期', dataIndex: 'date', width: 110 },
        { title: '房型', dataIndex: ['roomType', 'name'], width: 130 },
        { title: '责任渠道', width: 110, render: (_, r) => (
          <Space direction="vertical" size={0}>
            <b>{r.channel?.name}</b>
            <span style={{ color: '#cf1322', fontSize: 12 }}>{r.channelResponsibility}</span>
          </Space>
        ) },
        { title: '超卖原因', dataIndex: 'reason' },
        { title: '客人', width: 180, render: (_, r) => (
          <Space size={4} wrap>{r.guestNames.map((g, i) => <Tag key={i}>{g}</Tag>)}</Space>
        ) },
        { title: '处理进度', width: 100, render: (_, r) => `${r.acceptedCount}/${r.itemCount} 已接受` },
        { title: '补偿成本', dataIndex: 'totalCompensationCost', width: 100, render: (v) => v > 0 ? `¥${v}` : '-' },
        { title: '状态', dataIndex: 'status', width: 110, render: (v) => <Tag color={OVERSELL_CASE_STATUS[v]?.color}>{OVERSELL_CASE_STATUS[v]?.text}</Tag> },
        { title: '操作', width: 80, render: (_, r) => <Button size="small" type="link" onClick={() => setCaseId(r.id)}>处理</Button> },
      ]} />

      <Modal title="检测超卖冲突" open={detectOpen} onCancel={() => setDetectOpen(false)}
        onOk={() => form.submit()} okText="检测并建案" destroyOnClose>
        <Form form={form} layout="vertical" initialValues={{ date: dayjs('2026-10-04'), delayMin: 28 }}
          onFinish={async (v) => {
            const c = await api.post('/oversells/detect', {
              roomTypeId: v.roomTypeId, date: v.date.format('YYYY-MM-DD'), delayMin: v.delayMin,
            });
            message.success('已生成超卖案件与处理优先级');
            setDetectOpen(false); setCaseId(c.id); load();
          }}>
          <Form.Item name="roomTypeId" label="房型" rules={[{ required: true }]}>
            <Select options={roomTypes.map((t) => ({ value: t.id, label: t.name }))} />
          </Form.Item>
          <Form.Item name="date" label="冲突入住日" rules={[{ required: true }]}>
            <DatePicker allowClear={false} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="delayMin" label="渠道房态延迟（分钟）">
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      <Drawer open={!!caseId} onClose={() => { setCaseId(null); load(); }} width={900}
        title="超卖案件处理">
        {caseId && <CaseDetail caseId={caseId} onChanged={() => load()} />}
      </Drawer>
    </>
  );
}

function CaseDetail({ caseId, onChanged }) {
  const [c, setC] = useState(null);
  const [propTarget, setPropTarget] = useState(null);

  const load = async () => setC(await api.get(`/oversells/cases/${caseId}`));
  useEffect(() => { load(); }, [caseId]);
  if (!c) return <Card loading />;

  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Alert type={c.status === 'resolved' ? 'success' : 'error'} showIcon
        message={<Space>
          <b>{c.code}</b>
          <Tag color={OVERSELL_CASE_STATUS[c.status]?.color}>{OVERSELL_CASE_STATUS[c.status]?.text}</Tag>
          {c.date} {c.roomType.name} · 责任渠道：{c.channel.name}
        </Space>}
        description={
          <div>
            <div>{c.reason}</div>
            <div style={{ marginTop: 4 }}>物理房量 {c.capacity} 间 / 冲突在订 {c.items.length} 位客人；
              前 {c.capacity} 名按综合评分保留原房，其余进入换房补偿流程。</div>
          </div>
        } />

      {c.items.map((it) => {
        const b = it.booking;
        const lvl = MEMBER_LEVELS[b.memberLevel] || MEMBER_LEVELS.none;
        const displaced = !it.retain && it.status !== 'kept';
        return (
          <Card key={it.id} size="small"
            title={<Space wrap>
              <b>#{it.rank} {b.guestName}</b>
              <Tag color={lvl.color}>{lvl.text}{b.memberPoints ? `/${b.memberPoints}分` : ''}</Tag>
              <span style={{ color: '#888', fontWeight: 400 }}>{b.code} · {b.channel.name}</span>
              <span style={{ color: '#888', fontWeight: 400 }}>预计到店 {b.estimatedArrival ? dayjs(b.estimatedArrival).format('MM-DD HH:mm') : '未报'}</span>
              <span style={{ color: '#888', fontWeight: 400 }}>{b.nights}晚 ¥{b.totalAmount}</span>
              <Tag color={OVERSELL_ITEM_STATUS[it.status]?.color}>{OVERSELL_ITEM_STATUS[it.status]?.text}</Tag>
              {it.option && OVERSELL_OPTIONS[it.option] && <Tag color={OVERSELL_OPTIONS[it.option].color}>{OVERSELL_OPTIONS[it.option].text}</Tag>}
            </Space>}
            extra={<Space>
              <b style={{ color: displaced ? '#cf1322' : '#2f6b4f' }}>综合评分 {it.priorityScore}</b>
              {displaced && it.status !== 'accepted' && it.status !== 'declined' && (
                <Button type="primary" size="small" onClick={() => setPropTarget(it)}>
                  {it.status === 'proposed' ? '修改方案' : '提出方案'}
                </Button>
              )}
            </Space>}>
            <Row gutter={12}>
              <Col span={10}>
                <div style={{ fontSize: 12, color: '#666', marginBottom: 4 }}>评分因子</div>
                {it.scoreDetails.map((d, i) => (
                  <div key={i} style={{ fontSize: 12 }}>
                    <Space size={4}>
                      <Tag style={{ minWidth: 42, textAlign: 'center' }}>{d.points}</Tag>
                      <b>{d.label}</b>
                      <span style={{ color: '#999' }}>{d.note}</span>
                    </Space>
                  </div>
                ))}
              </Col>
              <Col span={14}>
                <ItemPlan it={it} c={c} reload={load} onChanged={onChanged} />
              </Col>
            </Row>
          </Card>
        );
      })}

      {propTarget && (
        <ProposeModal item={propTarget} caseInfo={c} onClose={() => { setPropTarget(null); load(); }} />
      )}
    </Space>
  );
}

function ItemPlan({ it, c, reload, onChanged }) {
  const [satOpen, setSatOpen] = useState(false);
  const [rating, setRating] = useState(0);
  const b = it.booking;

  if (it.status === 'kept') return <Alert type="info" showIcon message="按评分排名保留原房，无需挪房" />;

  if (it.status === 'proposed') {
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <PlanSummary it={it} />
        <Space>
          <Popconfirm title="确认客人接受该方案？将落账并调整库存/结算口径"
            onConfirm={async () => { await api.post(`/oversells/items/${it.id}/decide`, { accepted: true }); message.success('客人已接受，方案已落实'); reload(); onChanged(); }}>
            <Button type="primary" size="small">客人接受</Button>
          </Popconfirm>
          <Popconfirm title="客人拒绝该方案？需要重新协调"
            onConfirm={async () => { await api.post(`/oversells/items/${it.id}/decide`, { accepted: false }); message.warning('已记录拒绝，请重新出方案'); reload(); onChanged(); }}>
            <Button danger size="small">客人拒绝</Button>
          </Popconfirm>
        </Space>
      </Space>
    );
  }

  if (it.status === 'accepted') {
    return (
      <Space direction="vertical" style={{ width: '100%' }}>
        <PlanSummary it={it} />
        <div style={{ color: '#389e0d', fontSize: 12 }}>客人回应：{it.guestResponse || '接受'}</div>
        {it.option === 'partner' && (
          <Space>
            {it.guestSatisfaction !== null ? (
              <span>回访满意度：<Rate disabled value={Number(it.guestSatisfaction)} style={{ fontSize: 14 }} /></span>
            ) : (
              <Button size="small" onClick={() => setSatOpen(true)}>回访登记满意度</Button>
            )}
          </Space>
        )}
        <Modal title={`转住回访 · ${b.guestName}`} open={satOpen} onCancel={() => setSatOpen(false)}
          onOk={async () => {
            await api.post(`/oversells/items/${it.id}/satisfaction`, { rating });
            message.success('满意度已记录'); setSatOpen(false); reload();
          }} okText="提交">
          <Rate value={rating} onChange={setRating} />
        </Modal>
      </Space>
    );
  }

  if (it.status === 'declined') {
    return <Alert type="warning" showIcon message={`客人拒绝：${it.guestResponse}`} />;
  }
  return <span style={{ color: '#999' }}>待管家提出方案（升级房 / 合作民宿转住 / 退款补偿）</span>;
}

function PlanSummary({ it }) {
  if (it.option === 'upgrade') {
    return <Alert type="success" showIcon message={
      <Space direction="vertical" size={2}>
        <b>升级至 {it.upgradeRoom?.code} 房（更高房型）</b>
        <span style={{ fontSize: 12 }}>升级房总价 ¥{it.upgradePrice}，向客人加收 ¥{it.upgradeSurcharge || 0}，平台吸收差价与补偿合计成本 ¥{it.platformCost}</span>
      </Space>
    } />;
  }
  if (it.option === 'partner') {
    return <Alert type="success" showIcon message={
      <Space direction="vertical" size={2}>
        <b>转住「{it.partner?.name}」（距本店 {it.partnerDistanceKm} km · {SETTLE_METHODS[it.partnerSettlementMethod]}）</b>
        <span style={{ fontSize: 12 }}>合作方价 ¥{it.partnerPrice}/晚，平台结算成本 ¥{it.platformCost}</span>
        {it.settlementGuard && <span style={{ fontSize: 12, color: '#cf1322' }}>⚠ {it.settlementGuard}</span>}
      </Space>
    } />;
  }
  return <Alert type="warning" showIcon message={
    <span>退款补偿 ¥{it.compensationAmount}（客人自行解决），平台成本 ¥{it.platformCost}</span>
  } />;
}

function ProposeModal({ item, caseInfo, onClose }) {
  const [option, setOption] = useState('partner');
  const [form] = Form.useForm();
  const b = item.booking;
  return (
    <Modal title={`为 ${b.guestName} 提出换房补偿方案`} open onCancel={onClose}
      onOk={() => form.submit()} okText="向客人提议" width={620} destroyOnClose>
      <Radio.Group value={option} onChange={(e) => setOption(e.target.value)} style={{ marginBottom: 12 }}
        optionType="button" buttonStyle="solid"
        options={[
          { value: 'upgrade', label: '安排升级房' },
          { value: 'partner', label: '同村合作民宿转住' },
          { value: 'refund', label: '退款补偿（客人自行解决）' },
        ]} />
      <Form form={form} layout="vertical" initialValues={{ compensationAmount: 100, surcharge: 0 }}
        onFinish={async (v) => {
          const payload = { option, compensationAmount: v.compensationAmount || 0, surcharge: v.surcharge || 0 };
          if (option === 'upgrade') payload.upgradeRoomId = v.upgradeRoomId;
          if (option === 'partner') payload.partnerRoomId = v.partnerRoomId;
          if (option === 'refund') payload.compensationType = v.compensationType || 'refund';
          await api.post(`/oversells/items/${item.id}/propose`, payload);
          message.success('方案已提议，等待客人答复');
          onClose();
        }}>
        {option === 'upgrade' && (
          <Form.Item name="upgradeRoomId" label="选择升级房间（价格更高且该时段空房）" rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label"
              options={item.upgradeOptions.map((o) => ({
                value: o.roomId,
                label: `${o.roomCode} ${o.roomTypeName}（${o.totalNights ? '' : ''}全程¥${o.totalPrice}，平台吸收差价¥${o.absorbedDiff}）`,
              }))} />
          </Form.Item>
        )}
        {option === 'partner' && (
          <Form.Item name="partnerRoomId" label="选择合作民宿当日房源（合作方价/距离/结算方式）" rules={[{ required: true }]}>
            <Select showSearch optionFilterProp="label"
              options={item.partnerOptions.map((p) => ({
                value: p.partnerRoomId,
                label: `${p.partnerName} · ${p.roomName} ¥${p.partnerPrice}/晚（${p.distanceKm}km/${SETTLE_METHODS[p.settlementMethod]}/余${p.remaining}）`,
              }))} />
          </Form.Item>
        )}
        {option === 'refund' && (
          <Form.Item name="compensationType" label="退款方式">
            <Select options={[{ value: 'refund', label: '原路退款' }, { value: 'cash', label: '现金赔付' }, { value: 'voucher', label: '补偿券' }]} />
          </Form.Item>
        )}
        {option !== 'refund' && (
          <Form.Item name="compensationAmount" label="额外补偿金额（¥，可填 0）">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        )}
        {option === 'refund' && (
          <Form.Item name="compensationAmount" label="退款/补偿金额（¥）" rules={[{ required: true }]}>
            <InputNumber min={1} style={{ width: '100%' }} />
          </Form.Item>
        )}
        {option === 'upgrade' && (
          <Form.Item name="surcharge" label="向客人加收（¥，通常 0 由平台吸收）">
            <InputNumber min={0} style={{ width: '100%' }} />
          </Form.Item>
        )}
      </Form>
    </Modal>
  );
}

// ============ 合作民宿 ============
function PartnersPane() {
  const [inns, setInns] = useState([]);
  const [rooms, setRooms] = useState([]);
  const [addOpen, setAddOpen] = useState(false);
  const [form] = Form.useForm();

  const load = async () => {
    const [i, r] = await Promise.all([api.get('/partners'), api.get('/partners/rooms?from=2026-09-28&to=2026-10-16')]);
    setInns(i); setRooms(r);
  };
  useEffect(() => { load(); }, []);

  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Button type="primary" onClick={() => setAddOpen(true)}>登记合作房源/报价</Button>
        <span style={{ color: '#888' }}>记录合作方价格、距离与结算方式；转住后占用合作房量，结算时渠道不得再按原房型结算</span>
      </Space>
      <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
        {inns.map((p) => (
          <Col key={p.id} xs={24} md={8}>
            <Card size="small" title={p.name} extra={<Tag>{SETTLE_METHODS[p.settlementMethod]}</Tag>}>
              <Descriptions column={1} size="small">
                <Descriptions.Item label="位置">{p.village} · {p.distanceKm} km</Descriptions.Item>
                <Descriptions.Item label="联系人">{p.contactName} {p.contactPhone}</Descriptions.Item>
                <Descriptions.Item label="备注">{p.note || '-'}</Descriptions.Item>
              </Descriptions>
            </Card>
          </Col>
        ))}
      </Row>
      <Table dataSource={rooms} rowKey="id" size="middle" pagination={{ pageSize: 10 }} columns={[
        { title: '日期', dataIndex: 'date', width: 120 },
        { title: '合作民宿', dataIndex: ['partner', 'name'], width: 140 },
        { title: '距离(km)', dataIndex: ['partner', 'distanceKm'], width: 90 },
        { title: '房型', dataIndex: 'roomName' },
        { title: '合作方价/晚', dataIndex: 'partnerPrice', width: 120, render: (v) => `¥${v}` },
        { title: '结算方式', width: 100, render: (_, r) => SETTLE_METHODS[r.partner.settlementMethod] },
        { title: '余量', dataIndex: 'remaining', width: 80, render: (v) => v > 0 ? <Tag color="green">余 {v}</Tag> : <Tag color="red">满</Tag> },
      ]} />
      <Modal title="登记合作民宿房源与报价" open={addOpen} onCancel={() => setAddOpen(false)}
        onOk={() => form.submit()} okText="保存" destroyOnClose>
        <Form form={form} layout="vertical" initialValues={{ date: dayjs('2026-10-04'), available: 1 }}
          onFinish={async (v) => {
            await api.post('/partners/rooms', { ...v, date: v.date.format('YYYY-MM-DD') });
            message.success('已登记'); setAddOpen(false); load();
          }}>
          <Form.Item name="partnerId" label="合作民宿" rules={[{ required: true }]}>
            <Select options={inns.map((p) => ({ value: p.id, label: `${p.name}（${p.distanceKm}km）` }))} />
          </Form.Item>
          <Form.Item name="date" label="日期" rules={[{ required: true }]}><DatePicker allowClear={false} style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="roomName" label="房型名称" rules={[{ required: true }]}><Input placeholder="如：观景大床房" /></Form.Item>
          <Space>
            <Form.Item name="partnerPrice" label="合作方价(¥/晚)" rules={[{ required: true }]}><InputNumber min={0} /></Form.Item>
            <Form.Item name="available" label="可接收房量"><InputNumber min={1} /></Form.Item>
          </Space>
        </Form>
      </Modal>
    </>
  );
}

// ============ 渠道同步策略 ============
function PoliciesPane() {
  const [rows, setRows] = useState([]);
  const [target, setTarget] = useState(null);
  const [form] = Form.useForm();
  const load = async () => setRows(await api.get('/oversells/sync-policies'));
  useEffect(() => { load(); }, []);

  return (
    <>
      <Alert style={{ marginBottom: 12 }} type="info" showIcon
        message="店主复盘时可收紧房态推送间隔、预留安全缓冲房量，或将高风险渠道改为人工确认放房，防止下一轮再次超卖。" />
      <Table dataSource={rows} rowKey="id" pagination={false} columns={[
        { title: '渠道', dataIndex: 'channelName', width: 120 },
        { title: '同步间隔(分)', dataIndex: 'syncIntervalMin', width: 110 },
        { title: '安全缓冲(间)', dataIndex: 'safetyBuffer', width: 110 },
        { title: '同步方式', dataIndex: 'mode', width: 130, render: (v) => <Tag color={SYNC_MODES[v]?.color}>{SYNC_MODES[v]?.text}</Tag> },
        { title: '超卖案件', dataIndex: 'oversellCases', width: 100, render: (v) => v > 0 ? <Tag color="red">{v} 起</Tag> : '0' },
        { title: '备注', dataIndex: 'note', render: (v) => v || '-' },
        { title: '操作', width: 90, render: (_, r) => <Button size="small" type="link" onClick={() => setTarget(r)}>调整</Button> },
      ]} />
      {target && (
        <Modal title={`调整同步策略 · ${target.channelName}`} open onCancel={() => setTarget(null)}
          onOk={() => form.submit()} okText="保存策略" destroyOnClose>
          <Form form={form} layout="vertical"
            initialValues={{ syncIntervalMin: target.syncIntervalMin, safetyBuffer: target.safetyBuffer, mode: target.mode, note: target.note }}
            onFinish={async (v) => {
              await api.post(`/oversells/sync-policies/${target.channelId}`, v);
              message.success('同步策略已调整'); setTarget(null); load();
            }}>
            <Form.Item name="syncIntervalMin" label="房态推送间隔（分钟）"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="safetyBuffer" label="安全缓冲房量（间不投放）"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
            <Form.Item name="mode" label="放房方式">
              <Select options={Object.entries(SYNC_MODES).map(([v, m]) => ({ value: v, label: m.text }))} />
            </Form.Item>
            <Form.Item name="note" label="复盘结论"><Input.TextArea rows={2} /></Form.Item>
          </Form>
        </Modal>
      )}
    </>
  );
}

// ============ 超卖复盘 ============
function ReviewPane() {
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/analytics/oversell-review').then(setData); }, []);
  if (!data) return <Card loading />;
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Row gutter={16}>
        <Col span={6}><Card><Statistic title="超卖案件" value={data.totals.cases} suffix="起" /></Card></Col>
        <Col span={6}><Card><Statistic title="补偿成本合计" value={data.totals.cost} prefix="¥" valueStyle={{ color: '#cf1322' }} /></Card></Col>
        <Col span={6}><Card><Statistic title="合作民宿转住" value={data.totals.partner} suffix="人次" /></Card></Col>
        <Col span={6}><Card><Statistic title="升级房 / 退款" value={`${data.totals.upgrade} / ${data.totals.refund}`} /></Card></Col>
      </Row>
      <Card title="按渠道责任与同步策略建议">
        <Table dataSource={data.byChannel} rowKey="channelId" pagination={false} columns={[
          { title: '渠道', dataIndex: 'channel', width: 120 },
          { title: '案件', dataIndex: 'cases', width: 70 },
          { title: '成本', dataIndex: 'cost', width: 90, render: (v) => `¥${v}` },
          { title: '升级/转住/退款', width: 130, render: (_, r) => `${r.upgrade}/${r.partner}/${r.refund}` },
          { title: '当前策略', width: 200, render: (_, r) => r.policy ? `${r.policy.syncIntervalMin}分钟 / 缓冲${r.policy.safetyBuffer} / ${SYNC_MODES[r.policy.mode]?.text}` : '-' },
          { title: '调整建议', dataIndex: ['suggestion', 'text'] },
        ]} />
      </Card>
      <Card title="案件与转住明细（合作方价格 / 距离 / 满意度 / 结算方式）">
        <Table dataSource={data.cases} rowKey="code" pagination={false} columns={[
          { title: '案件', dataIndex: 'code', width: 120 },
          { title: '日期', dataIndex: 'date', width: 100 },
          { title: '房型', dataIndex: 'roomType', width: 120 },
          { title: '渠道', dataIndex: 'channel', width: 100 },
          { title: '原因', dataIndex: 'reason' },
          { title: '成本', dataIndex: 'totalCost', width: 90, render: (v) => `¥${v}` },
          { title: '转住回访', width: 90, render: (_, r) => r.avgSatisfaction ? <Rate disabled value={r.avgSatisfaction} style={{ fontSize: 13 }} /> : '-' },
        ]}
          expandable={{ expandedRowRender: (r) => r.partnerTransfers.length ? (
            <Table size="small" rowKey="guest" dataSource={r.partnerTransfers} pagination={false} columns={[
              { title: '客人', dataIndex: 'guest' },
              { title: '合作民宿', dataIndex: 'partner' },
              { title: '合作方价/晚', dataIndex: 'pricePerNight', render: (v) => `¥${v}` },
              { title: '结算额', dataIndex: 'payout', render: (v) => `¥${v}` },
              { title: '距离(km)', dataIndex: 'distanceKm' },
              { title: '结算方式', dataIndex: 'method', render: (v) => SETTLE_METHODS[v] },
              { title: '满意度', dataIndex: 'satisfaction', render: (v) => v !== null ? <Rate disabled value={v} style={{ fontSize: 13 }} /> : '未回访' },
            ]} />
          ) : <span style={{ color: '#999' }}>无合作民宿转住记录</span> }}
        />
      </Card>
    </Space>
  );
}
