import React, { useEffect, useMemo, useState } from 'react';
import {
  Alert, Badge, Button, Card, Descriptions, Drawer, Form, Input, InputNumber, Modal,
  Popconfirm, Radio, Select, Space, Statistic, Switch, Table, Tabs, Tag, Timeline, message,
} from 'antd';
import dayjs from 'dayjs';
import api, {
  CLAIM_STATUS, MEMBER_LEVELS, OVERSELL_CASE_STATUS, OVERSELL_RESOLUTION,
  PARTNER_SETTLEMENT, RESPONSIBILITY,
} from '../api';

export default function Oversell() {
  const [cases, setCases] = useState([]);
  const [channels, setChannels] = useState([]);
  const [genOpen, setGenOpen] = useState(false);
  const [openIncidents, setOpenIncidents] = useState([]);
  const [activeId, setActiveId] = useState(null);
  const [detail, setDetail] = useState(null);
  const [reloadKey, setReloadKey] = useState(0);

  const load = async () => {
    const [cs, ch, inc] = await Promise.all([
      api.get('/oversell/cases'),
      api.get('/channels'),
      api.get('/incidents', { params: { type: 'oversell', status: 'open' } }),
    ]);
    setCases(cs); setChannels(ch);
    setOpenIncidents(inc.filter((i) => i.bookingId && !cs.some((c) => c.incidentId === i.id)));
  };
  useEffect(() => { load(); }, [reloadKey]);
  useEffect(() => {
    if (activeId) api.get(`/oversell/cases/${activeId}`).then(setDetail);
  }, [activeId, reloadKey]);

  const refresh = () => setReloadKey((k) => k + 1);

  return (
    <Card title="渠道超卖 · 换房补偿处置" extra={
      <Button type="primary" onClick={setGenOpen.bind(null, true)}>从超卖事件生成处置工单</Button>
    }>
      <Alert style={{ marginBottom: 12 }} type="info" showIcon
        message="OTA 延迟同步导致同房被多渠道预订时，平台按 下单时间、到店时间、房型价值、会员等级 计算保留优先级，管家可安排：店内升级房 / 同村合作民宿转住 / 退款补偿；客人接受后原订单保留超卖原因、补偿成本与渠道责任，结算口径锁定。" />
      <Table dataSource={cases} rowKey="id" size="middle" pagination={{ pageSize: 8 }} columns={[
        { title: '工单号', dataIndex: 'code', width: 100 },
        { title: '订单/客人', width: 150, render: (_, r) => (
          <div><b>{r.booking?.code}</b><div style={{ color: '#888', fontSize: 12 }}>{r.booking?.guestName}</div></div>
        ) },
        { title: '会员', dataIndex: 'memberLevel', width: 90,
          render: (v) => <Tag color={MEMBER_LEVELS[v]?.color}>{MEMBER_LEVELS[v]?.text}</Tag> },
        { title: '房型', width: 110, render: (_, r) => r.roomType?.name },
        { title: '下单渠道/责任渠道', width: 160, render: (_, r) => (
          <Space size={4} wrap>
            <Tag>{r.channel?.name}</Tag>
            {r.responsibleChannelId !== r.channelId && <Tag color="red">责:{r.responsibleChannel?.name}</Tag>}
          </Space>
        ) },
        { title: '优先级分', dataIndex: 'priorityScore', width: 90,
          render: (v) => <b style={{ color: '#d46b08' }}>{v}</b> },
        { title: '处置方式', dataIndex: 'resolutionType', width: 120,
          render: (v) => v ? <Tag color={OVERSELL_RESOLUTION[v]?.color}>{OVERSELL_RESOLUTION[v]?.text}</Tag> : '-' },
        { title: '补偿成本', width: 90, render: (_, r) => Number(r.compensationCost) + Number(r.partnerCost) > 0
          ? `¥${(Number(r.compensationCost) + Number(r.partnerCost)).toFixed(0)}` : '-' },
        { title: '渠道索赔', width: 130, render: (_, r) => Number(r.channelClaimAmount) > 0
          ? <Space size={4}>¥{r.channelClaimAmount}<Tag color={CLAIM_STATUS[r.channelClaimStatus]?.color}>{CLAIM_STATUS[r.channelClaimStatus]?.text}</Tag></Space> : '-' },
        { title: '满意度', dataIndex: 'guestSatisfaction', width: 80, render: (v) => v > 0 ? `${v}分` : '-' },
        { title: '状态', dataIndex: 'status', width: 100,
          render: (v) => <Tag color={OVERSELL_CASE_STATUS[v]?.color}>{OVERSELL_CASE_STATUS[v]?.text}</Tag> },
        { title: '操作', width: 80, render: (_, r) => <a onClick={() => { setActiveId(r.id); setDetail(null); }}>处置</a> },
      ]} />

      <Modal title="从待处理超卖事件生成处置工单" open={genOpen} onCancel={() => setGenOpen(false)} footer={null} destroyOnClose>
        {openIncidents.length === 0 ? <Alert type="success" showIcon message="所有超卖事件均已生成工单" /> : (
          <Table size="small" rowKey="id" pagination={false} dataSource={openIncidents} columns={[
            { title: '事件', dataIndex: 'description' },
            { title: '操作', width: 90, render: (_, r) => <GenCaseButton incident={r} channels={channels} onDone={() => { setGenOpen(false); refresh(); }} /> },
          ]} />
        )}
      </Modal>

      <Drawer width={760} open={!!activeId} onClose={() => setActiveId(null)}
        title={detail ? `超卖处置工单 ${detail.code}` : ''} destroyOnClose>
        {detail && <CaseDetail key={detail.id} detail={detail} channels={channels} refresh={refresh} />}
      </Drawer>

      <Tabs style={{ marginTop: 24 }} items={[
        { key: 'partners', label: '同村合作民宿', children: <PartnersTab reloadKey={reloadKey} /> },
        { key: 'policies', label: '渠道同步策略', children: <PoliciesTab channels={channels} reloadKey={reloadKey} refresh={refresh} /> },
        { key: 'review', label: '超卖复盘', children: <ReviewTab reloadKey={reloadKey} /> },
      ]} />
    </Card>
  );
}

function GenCaseButton({ incident, channels, onDone }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <a onClick={() => setOpen(true)}>生成工单</a>
      <Modal title="选择责任渠道（延迟同步的责任方）" open={open} onCancel={() => setOpen(false)} footer={null} destroyOnClose>
        <GenCaseForm incident={incident} channels={channels} onDone={() => { setOpen(false); onDone(); }} />
      </Modal>
    </>
  );
}

function GenCaseForm({ incident, channels, onDone }) {
  const [form] = Form.useForm();
  return (
    <Form form={form} layout="vertical" initialValues={{ responsibleChannelId: channels.find((c) => c.code === 'ota')?.id }}
      onFinish={async (v) => {
        await api.post('/oversell/cases', { incidentId: incident.id, ...v });
        message.success('处置工单已生成，已按四因子打分');
        onDone();
      }}>
      <Alert style={{ marginBottom: 12 }} type="warning" showIcon message={incident.description} />
      <Form.Item name="responsibleChannelId" label="责任渠道" rules={[{ required: true }]}>
        <Select options={channels.map((c) => ({ value: c.id, label: `${c.name}（佣金 ${(c.commissionRate * 100).toFixed(0)}%）` }))} />
      </Form.Item>
      <Button type="primary" htmlType="submit">生成并打分</Button>
    </Form>
  );
}

function CaseDetail({ detail, channels, refresh }) {
  const plan = detail.plan;
  return (
    <div>
      <Descriptions column={2} size="small" bordered items={[
        { key: 's', label: '状态', children: <Tag color={OVERSELL_CASE_STATUS[detail.status]?.color}>{OVERSELL_CASE_STATUS[detail.status]?.text}</Tag> },
        { key: 'r', label: '责任', children: <Tag color={RESPONSIBILITY[detail.channelResponsibility]?.color}>{RESPONSIBILITY[detail.channelResponsibility]?.text}</Tag> },
        { key: 'g', label: '客人', children: `${detail.booking?.guestName} ${detail.booking?.guestPhone || ''}` },
        { key: 'm', label: '会员', children: <Tag color={MEMBER_LEVELS[detail.memberLevel]?.color}>{MEMBER_LEVELS[detail.memberLevel]?.text}</Tag> },
        { key: 'o', label: '下单时间', children: dayjs(detail.orderedAt).format('MM-DD HH:mm') },
        { key: 'e', label: '预计到店', children: dayjs(detail.etaTime).format('MM-DD HH:mm') },
        { key: 'v', label: '房型价值(房费)', children: `¥${detail.roomTypeValue}` },
        { key: 'p', label: '保留优先级得分', children: <b style={{ color: '#d46b08' }}>{detail.priorityScore}</b> },
      ]} />
      <Alert style={{ margin: '12px 0' }} type="error" showIcon message={detail.incident?.description} />

      {plan && plan.factors.keeper && (
        <Alert style={{ marginBottom: 12 }} type="warning" showIcon
          message={`同房型冲突 ${plan.ranked.length} 单：本单排第 ${plan.factors.rank}，优先保留方为 ${plan.factors.keeper.guestName}（${plan.factors.keeper.code}，${plan.factors.keeper.score} 分）`} />
      )}

      {plan && (
        <Card size="small" title="冲突订单保留优先级（下单早/到店早/会员高/房值高 → 得分高；同房另一单优先保留原房）" style={{ marginBottom: 12 }}>
          {plan.factors.inhouse?.length > 0 && (
            <Alert style={{ marginBottom: 8 }} type="info" showIcon
              message={`在住客人直接保留房间：${plan.factors.inhouse.map((g) => `${g.guestName}(${g.roomCode})`).join('、')}`} />
          )}
          <Table size="small" rowKey="bookingId" pagination={false} dataSource={plan.ranked} columns={[
            { title: '订单', dataIndex: 'code', width: 96 },
            { title: '客人', dataIndex: 'guestName', width: 84 },
            { title: '房间', dataIndex: 'roomCode', width: 60 },
            { title: '会员', dataIndex: 'memberLevel', width: 74, render: (v) => MEMBER_LEVELS[v]?.text },
            { title: '下单', dataIndex: 'orderedAt', width: 104, render: (v) => dayjs(v).format('MM-DD HH:mm') },
            { title: '到店', dataIndex: 'etaTime', width: 104, render: (v) => dayjs(v).format('MM-DD HH:mm') },
            { title: '房费', dataIndex: 'roomFee', width: 74, render: (v) => `¥${v}` },
            { title: '下单分', dataIndex: 'orderPts', width: 64 },
            { title: '到店分', dataIndex: 'etaPts', width: 64 },
            { title: '会员分', dataIndex: 'memberPts', width: 64 },
            { title: '房值分', dataIndex: 'valuePts', width: 64 },
            { title: '总分', dataIndex: 'score', width: 64, render: (v) => <b>{v}</b> },
            { title: '判定', width: 110, render: (_, r) => r.bookingId === detail.bookingId
              ? <Tag color="volcano">本单（需安置）</Tag>
              : r.bookingId === plan.factors.keeper?.bookingId
                ? <Tag color="green">保留原房</Tag> : <Tag>保留</Tag> },
          ]} />
        </Card>
      )}

      {['open', 'rejected'].includes(detail.status) && plan && <ArrangePanel detail={detail} plan={plan} refresh={refresh} />}
      {detail.status === 'arranged' && <ArrangedPanel detail={detail} refresh={refresh} />}
      {detail.status === 'rejected' && !plan && <Alert type="error" showIcon message="客人拒绝了方案，请重新安排" style={{ marginBottom: 12 }} />}

      {['accepted', 'closed'].includes(detail.status) && <AcceptedPanel detail={detail} refresh={refresh} />}
    </div>
  );
}

function ArrangePanel({ detail, plan, refresh }) {
  const [form] = Form.useForm();
  const option = Form.useWatch('option', form);
  const upgradeId = Form.useWatch('roomId', form);
  const partnerId = Form.useWatch('partnerId', form);
  const [busy, setBusy] = useState(false);
  const upgradePick = useMemo(() => plan.options.upgrade.find((u) => u.roomId === upgradeId), [plan, upgradeId]);
  const partnerPick = useMemo(() => plan.options.partner.find((p) => p.partnerId === partnerId), [plan, partnerId]);

  const submit = async () => {
    const v = await form.validateFields();
    setBusy(true);
    try {
      await api.post(`/oversell/cases/${detail.id}/arrange`, v);
      message.success('方案已安排，等待客人确认');
      refresh();
    } finally { setBusy(false); }
  };

  return (
    <Card size="small" title={`安排处置方案（系统推荐：${OVERSELL_RESOLUTION[plan.recommendation]?.text}）`}
      extra={<Tag color="blue">推荐 {OVERSELL_RESOLUTION[plan.recommendation]?.text}</Tag>}>
      <Form form={form} layout="vertical" initialValues={{
        option: plan.recommendation,
        refundAmount: plan.options.refund.refundAmount,
        channelResponsibility: 'channel', compensationType: 'voucher', compensationAmount: 100,
      }}>
        <Form.Item name="option" label="处置方案">
          <Radio.Group optionType="button" buttonStyle="solid"
            options={[
              { value: 'upgrade', label: `店内升级房 (${plan.options.upgrade.length})`, disabled: !plan.options.upgrade.length },
              { value: 'partner', label: `合作民宿转住 (${plan.options.partner.length})`, disabled: !plan.options.partner.length },
              { value: 'refund', label: '退款补偿' },
            ]} />
        </Form.Item>

        {option === 'upgrade' && (
          <Form.Item name="roomId" label="选择升级房（差价平台承担）" rules={[{ required: true }]}>
            <Select options={plan.options.upgrade.map((u) => ({
              value: u.roomId,
              label: `${u.roomCode} ${u.roomType}｜新房费 ¥${u.newFee}，差价 ¥${u.upgradeCost}`,
            }))} />
          </Form.Item>
        )}
        {option === 'partner' && (
          <Form.Item name="partnerId" label="选择同村合作民宿（合作价结算，不再按原房型与渠道结算）" rules={[{ required: true }]}>
            <Select options={plan.options.partner.map((p) => ({
              value: p.partnerId,
              label: `${p.name}（${p.village}，${p.distanceKm}km，¥${p.pricePerNight}/晚 × ${detail.booking?.nights || 1}晚 = ¥${p.totalCost}，${PARTNER_SETTLEMENT[p.settlementType]}）`,
            }))} />
          </Form.Item>
        )}
        {option === 'refund' && (
          <Alert type="warning" showIcon style={{ marginBottom: 12 }}
            message={`全额退款 ¥${plan.options.refund.refundAmount}（原单应收 ¥${plan.options.refund.paidAmount}，OTA 佣金 ¥${plan.options.refund.commission} 将一并向渠道追讨）`} />
        )}
        {option === 'refund' && (
          <Form.Item name="refundAmount" label="退款金额"><InputNumber min={0} style={{ width: '100%' }} /></Form.Item>
        )}

        {option !== 'refund' && (
          <Space size={12} wrap>
            <Form.Item name="compensationType" label="善意补偿方式">
              <Select style={{ width: 130 }} options={[{ value: 'voucher', label: '补偿券' }, { value: 'cash', label: '现金' }]} />
            </Form.Item>
            <Form.Item name="compensationAmount" label="善意补偿金额（升级差价另计）">
              <InputNumber min={0} style={{ width: 160 }} />
            </Form.Item>
          </Space>
        )}

        <Space size={12} wrap>
          <Form.Item name="channelResponsibility" label="渠道责任划分">
            <Select style={{ width: 140 }} options={Object.entries(RESPONSIBILITY).map(([v, r]) => ({ value: v, label: r.text }))} />
          </Form.Item>
          <Form.Item name="channelClaimAmount" label="渠道索赔额（留空=按责任自动计算）">
            <InputNumber min={0} style={{ width: 200 }} placeholder="自动" />
          </Form.Item>
        </Space>
        <Form.Item name="note" label="给客人的说明/备注"><Input.TextArea rows={2} /></Form.Item>

        {option === 'upgrade' && upgradePick && (
          <Alert style={{ marginBottom: 12 }} type="info" showIcon
            message={`平台承担：房型差价 ¥${upgradePick.upgradeCost} + 善意补偿（按上表），原订单保留原房型用于渠道结算`} />
        )}
        {option === 'partner' && partnerPick && (
          <Alert style={{ marginBottom: 12 }} type="info" showIcon
            message={`合作方支出 ¥${partnerPick.totalCost}（${PARTNER_SETTLEMENT[partnerPick.settlementType]}）+ 善意补偿；结算将锁定为合作价，防止渠道仍按原房型结算`} />
        )}

        <Button type="primary" loading={busy} onClick={submit}>安排方案</Button>
      </Form>
    </Card>
  );
}

function ArrangedPanel({ detail, refresh }) {
  const [satisfaction, setSatisfaction] = useState(5);
  const [compType, setCompType] = useState('voucher');
  return (
    <Card size="small" title="方案已安排，请客人确认" style={{ marginBottom: 12 }}>
      <Timeline items={[
        { color: 'blue', children: <b>{OVERSELL_RESOLUTION[detail.resolutionType]?.text}</b> },
        { children: detail.resolution },
        { children: `渠道责任：${RESPONSIBILITY[detail.channelResponsibility]?.text}；拟索赔 ¥${detail.channelClaimAmount}（${CLAIM_STATUS[detail.channelClaimStatus]?.text}）` },
      ]} />
      <Space wrap>
        <Select value={compType} onChange={setCompType} style={{ width: 120 }}
          options={[{ value: 'voucher', label: '补偿券' }, { value: 'cash', label: '现金' }]} />
        <span>客人满意度：</span>
        <InputNumber min={1} max={5} value={satisfaction} onChange={setSatisfaction} />
        <Popconfirm title="确认客人已接受？将执行换房/释放库存/发放补偿并锁定结算口径"
          onConfirm={async () => {
            await api.post(`/oversell/cases/${detail.id}/accept`, { satisfaction, compensationType: compType });
            message.success('客人已接受，处置已执行，结算口径已锁定');
            refresh();
          }}>
          <Button type="primary">客人接受，执行</Button>
        </Popconfirm>
        <Button danger onClick={async () => {
          const note = window.prompt('客人拒绝原因（可选）') || '';
          await api.post(`/oversell/cases/${detail.id}/reject`, { note });
          message.success('已记录拒绝，可重新安排方案');
          refresh();
        }}>客人拒绝</Button>
      </Space>
    </Card>
  );
}

function AcceptedPanel({ detail, refresh }) {
  const [score, setScore] = useState(detail.guestSatisfaction || 5);
  return (
    <Card size="small" title="处置结果（原订单保留超卖原因、补偿成本与渠道责任）" style={{ marginBottom: 12 }}>
      <Timeline items={[
        { color: 'green', children: <><Tag color="green">客人已接受</Tag><b>{OVERSELL_RESOLUTION[detail.resolutionType]?.text}</b></> },
        { children: detail.resolution },
        { children: `补偿成本 ¥${detail.compensationCost}${detail.partnerCost ? `，合作方支出 ¥${detail.partnerCost}` : ''}` },
        { children: `渠道责任：${RESPONSIBILITY[detail.channelResponsibility]?.text}；索赔 ¥${detail.channelClaimAmount}（${CLAIM_STATUS[detail.channelClaimStatus]?.text}）` },
      ]} />
      {detail.settlementLocked && <Tag color="green" style={{ marginBottom: 12 }}>结算口径已锁定（合作价/差价/索赔），渠道不再按原房型重复结算</Tag>}
      <Space wrap style={{ display: 'flex' }}>
        <span>回访满意度：</span>
        <InputNumber min={1} max={5} value={score} onChange={setScore} />
        <Button onClick={async () => {
          const note = window.prompt('回访备注（可选）') || '';
          await api.post(`/oversell/cases/${detail.id}/satisfaction`, { score, note });
          message.success('满意度已记录'); refresh();
        }}>保存满意度</Button>
        {detail.channelClaimStatus === 'claimed' && (
          <>
            <Popconfirm title="确认渠道索赔已到账？将计入订单结算收入" onConfirm={async () => {
              await api.post(`/oversell/cases/${detail.id}/claim`, { status: 'settled' });
              message.success('索赔已到账，计入结算'); refresh();
            }}>
              <Button type="primary">索赔到账</Button>
            </Popconfirm>
            <Button onClick={async () => {
              await api.post(`/oversell/cases/${detail.id}/claim`, { status: 'waived' });
              message.success('已放弃该笔索赔'); refresh();
            }}>放弃索赔</Button>
          </>
        )}
      </Space>
      {detail.guestNote && <Alert style={{ marginTop: 12 }} type="info" showIcon message={`客人反馈：${detail.guestNote}`} />}
    </Card>
  );
}

// ---------- 合作民宿 ----------
function PartnersTab({ reloadKey }) {
  const [list, setList] = useState([]);
  const [editing, setEditing] = useState(null);
  const [form] = Form.useForm();
  const load = async () => setList(await api.get('/oversell/partners'));
  useEffect(() => { load(); }, [reloadKey]);

  const columns = [
    { title: '编号', dataIndex: 'code', width: 80 },
    { title: '名称', dataIndex: 'name' },
    { title: '位置', dataIndex: 'village' },
    { title: '合作价/晚', dataIndex: 'pricePerNight', width: 100, render: (v) => `¥${v}` },
    { title: '距离', dataIndex: 'distanceKm', width: 80, render: (v) => `${v}km` },
    { title: '结算方式', dataIndex: 'settlementType', width: 90, render: (v) => PARTNER_SETTLEMENT[v] },
    { title: '联系人', width: 140, render: (_, r) => `${r.contact || '-'} ${r.phone || ''}` },
    { title: '状态', dataIndex: 'status', width: 90, render: (v) =>
      v === 'available' ? <Tag color="green">可接待</Tag> : v === 'full' ? <Tag color="orange">已满房</Tag> : <Tag>已暂停</Tag> },
    { title: '操作', width: 120, render: (_, r) => (
      <Space>
        <a onClick={() => { setEditing(r); form.setFieldsValue(r); }}>编辑</a>
        <a onClick={async () => {
          await api.put(`/oversell/partners/${r.id}`, { status: r.status === 'available' ? 'suspended' : 'available' });
          message.success('状态已更新'); load();
        }}>{r.status === 'available' ? '暂停' : '启用'}</a>
      </Space>
    ) },
  ];

  return (
    <>
      <Button type="primary" style={{ marginBottom: 12 }} onClick={() => { setEditing({}); form.resetFields(); }}>新增合作民宿</Button>
      <Table dataSource={list} rowKey="id" columns={columns} pagination={false} size="middle" />
      <Modal title={editing?.id ? '编辑合作民宿' : '新增合作民宿'} open={!!editing}
        onCancel={() => setEditing(null)} onOk={() => form.submit()} destroyOnClose>
        <Form form={form} layout="vertical" initialValues={{ settlementType: 'monthly', status: 'available' }}
          onFinish={async (v) => {
            if (editing.id) await api.put(`/oversell/partners/${editing.id}`, v);
            else await api.post('/oversell/partners', v);
            message.success('已保存'); setEditing(null); load();
          }}>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="village" label="位置（同村）" rules={[{ required: true }]}><Input /></Form.Item>
          <Space>
            <Form.Item name="pricePerNight" label="合作价/晚" rules={[{ required: true }]}><InputNumber min={0} /></Form.Item>
            <Form.Item name="distanceKm" label="距离(km)" rules={[{ required: true }]}><InputNumber min={0} step={0.1} /></Form.Item>
          </Space>
          <Space>
            <Form.Item name="settlementType" label="结算方式">
              <Select options={Object.entries(PARTNER_SETTLEMENT).map(([v, l]) => ({ value: v, label: l }))} />
            </Form.Item>
            {editing?.id && (
              <Form.Item name="status" label="状态">
                <Select options={[{ value: 'available', label: '可接待' }, { value: 'full', label: '满房' }, { value: 'suspended', label: '暂停' }]} />
              </Form.Item>
            )}
          </Space>
          <Space>
            <Form.Item name="contact" label="联系人"><Input /></Form.Item>
            <Form.Item name="phone" label="电话"><Input /></Form.Item>
          </Space>
        </Form>
      </Modal>
    </>
  );
}

// ---------- 渠道同步策略 ----------
function PoliciesTab({ channels, reloadKey, refresh }) {
  const [list, setList] = useState([]);
  const load = async () => setList(await api.get('/oversell/sync-policies'));
  useEffect(() => { load(); }, [reloadKey]);
  const save = async (channelId, v) => {
    if (v === null || v === undefined) return;
    await api.put(`/oversell/sync-policies/${channelId}`, v);
    message.success('同步策略已更新，下一轮节假日按新策略推送房态');
    load(); refresh();
  };
  return (
    <Table dataSource={list} rowKey="id" pagination={false} size="middle" columns={[
      { title: '渠道', width: 120, render: (_, r) => <b>{r.channelName}</b> },
      { title: '同步频率(分钟)', width: 200, render: (_, r) => (
        <InputNumber min={1} max={1440} defaultValue={r.syncIntervalMin}
          onChange={(v) => save(r.channelId, { syncIntervalMin: v })} />
      ) },
      { title: '缓冲房量', width: 160, render: (_, r) => (
        <InputNumber min={0} defaultValue={r.bufferRooms}
          onChange={(v) => save(r.channelId, { bufferRooms: v })} />
      ) },
      { title: '房态变化即时推送', width: 170, render: (_, r) => (
        <Switch defaultChecked={r.pushOnChange}
          onChange={(v) => save(r.channelId, { pushOnChange: v })} />
      ) },
      { title: '超卖风险', width: 170, render: (_, r) => {
        const risk = r.syncIntervalMin >= 30 || r.bufferRooms <= 0;
        return <Tag color={risk ? 'red' : 'green'}>{risk ? '高（同步慢/无缓冲房）' : '可控'}</Tag>;
      } },
      { title: '策略备注/复盘结论', render: (_, r) => (
        <Input defaultValue={r.note} onPressEnter={(e) => save(r.channelId, { note: e.target.value })}
          onBlur={(e) => { if (e.target.value !== r.note) save(r.channelId, { note: e.target.value }); }} />
      ) },
    ]} />
  );
}

// ---------- 超卖复盘 ----------
function ReviewTab({ reloadKey }) {
  const [data, setData] = useState(null);
  useEffect(() => { api.get('/oversell/review').then(setData); }, [reloadKey]);
  if (!data) return <Card loading />;
  return (
    <div>
      <Space size={32} wrap style={{ marginBottom: 16 }}>
        <Statistic title="超卖工单" value={data.total} suffix={`起（待处理 ${data.open}）`} />
        <Statistic title="已处置" value={data.accepted} suffix="起" />
        <Statistic title="补偿成本" value={data.totalCompensation} prefix="¥" valueStyle={{ color: '#cf1322' }} />
        <Statistic title="合作方支出" value={data.totalPartnerCost} prefix="¥" valueStyle={{ color: '#cf1322' }} />
        <Statistic title="渠道索赔" value={data.totalClaim} prefix="¥" valueStyle={{ color: '#2f6b4f' }} />
      </Space>
      <Card size="small" title="分渠道超卖责任与同步策略" style={{ marginBottom: 16 }}>
        <Table size="small" rowKey="channelCode" pagination={false} dataSource={data.byChannel} columns={[
          { title: '渠道', dataIndex: 'channelName', width: 100 },
          { title: '同步(分)/缓冲房', width: 130, render: (_, r) => `${r.syncIntervalMin} / ${r.bufferRooms}` },
          { title: '工单数', dataIndex: 'cases', width: 80 },
          { title: '已处置', dataIndex: 'resolved', width: 80 },
          { title: '补偿成本', dataIndex: 'compensationCost', width: 100, render: (v) => `¥${v}` },
          { title: '合作方支出', dataIndex: 'partnerCost', width: 100, render: (v) => v > 0 ? `¥${v}` : '-' },
          { title: '索赔金额', dataIndex: 'claimAmount', width: 100, render: (v) => v > 0 ? `¥${v}` : '-' },
          { title: '索赔到账', dataIndex: 'claimSettled', width: 100, render: (v) => v > 0 ? <span style={{ color: '#2f6b4f' }}>¥{v}</span> : '-' },
          { title: '风险', dataIndex: 'risk', render: (v) => <Tag color={v.startsWith('高') ? 'red' : 'green'}>{v}</Tag> },
        ]} />
      </Card>
      <Card size="small" title="合作民宿转住评估（价格 / 距离 / 满意度 / 结算方式）" style={{ marginBottom: 16 }}>
        <Table size="small" rowKey="partnerId" pagination={false} dataSource={data.partnerStats}
          locale={{ emptyText: '暂无转住记录' }} columns={[
            { title: '合作民宿', dataIndex: 'name' },
            { title: '位置', dataIndex: 'village' },
            { title: '转住次数', dataIndex: 'cases', width: 90 },
            { title: '客人满意度', dataIndex: 'avgSatisfaction', width: 110,
              render: (v) => v ? <Tag color={v >= 4 ? 'green' : v >= 3 ? 'orange' : 'red'}>{v}分</Tag> : '-' },
            { title: '结算方式', dataIndex: 'settlementTypes', width: 140,
              render: (v) => v.map((t) => PARTNER_SETTLEMENT[t]).join('、') },
            { title: '合作方支出合计', dataIndex: 'cost', width: 120, render: (v) => `¥${v}` },
          ]} />
      </Card>
      <Card size="small" title="渠道责任分布">
        <Table size="small" rowKey="responsibility" pagination={false} dataSource={data.responsibility} columns={[
          { title: '责任划分', dataIndex: 'label', width: 120, render: (v, r) => <Tag color={RESPONSIBILITY[r.responsibility]?.color}>{v}</Tag> },
          { title: '工单数', dataIndex: 'count', width: 100 },
          { title: '平台承担成本', dataIndex: 'cost', render: (v) => `¥${v}` },
        ]} />
      </Card>
    </div>
  );
}
