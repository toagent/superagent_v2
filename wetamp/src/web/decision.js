const $ = id => document.getElementById(id);
let csrf = '',
  selected = new URL(location.href).searchParams.get('decision'),
  busy = false,
  revokeBusy = false,
  latest;
async function request(path, data) {
  const response = await fetch(path, {
    cache: 'no-store',
    ...(data
      ? {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-csrf-token': csrf },
          body: JSON.stringify(data),
        }
      : {}),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '请求失败');
  return value;
}
const statuses = {
  paused: '引擎暂停 / 等待处理',
  running: '引擎正在执行',
  pending: '引擎排队中',
  completed: '引擎已完成',
  failed: '引擎执行失败',
  cancelled: '引擎已取消',
  unknown: '观察丢失，当前状态未知',
};
async function refresh() {
  try {
    const view = await request('/sa/decisions');
    csrf = view.csrf;
    latest = view;
    $('setup').hidden = true;
    const state = selected ? await request('/sa/decisions/' + selected + '/state') : view;
    $('connection').textContent = state.lastRead
      ? '最后成功读取：' + new Date(state.lastRead).toLocaleString()
      : '状态未知；保留上次读取，不推断完成';
    $('state').textContent = (statuses[state.status] || '状态未知') + '。' + state.note;
    $('receipt').textContent = state.receipt
      ? {
          intent: '提交意图已保存，受理尚未确认',
          accepted: '引擎已接收；续跑尚未确认',
          resuming: '续跑请求已受理，执行结果以上方状态为准',
          unknown: '提交结果未知，请在 Mac 核验；不会自动重发',
        }[state.receipt.stage]
      : state.stale
        ? '旧通知已失效，请回到当前事项'
        : '尚未提交';
    const decision = state.decision;
    $('item').hidden = !decision;
    $('options').replaceChildren();
    if (decision) {
      $('question').textContent = decision.question;
      $('reason').textContent = decision.reason;
      $('context').textContent = decision.context;
      $('disabled').textContent = decision.disabled || '';
      for (const option of decision.options) {
        const button = document.createElement('button'),
          label = document.createElement('strong'),
          consequence = document.createElement('span');
        label.textContent = option.label;
        consequence.textContent = option.consequence;
        button.append(label, consequence);
        button.disabled = !!decision.disabled || !!state.receipt || busy;
        button.onclick = async () => {
          if (busy || !confirm(decision.question + '\n' + option.label + '\n' + option.consequence))
            return;
          busy = true;
          for (const b of $('options').children) b.disabled = true;
          selected = decision.id;
          try {
            await request('/sa/decisions/' + decision.id + '/answer', { decision: option.id });
          } catch (e) {
            $('connection').textContent = e.message + '；提交结果需重新读取，禁止自动重发';
          } finally {
            busy = false;
            await refresh();
          }
        };
        $('options').append(button);
      }
    }
    $('events').replaceChildren(
      ...state.events.map(e => {
        const li = document.createElement('li');
        li.textContent = [e.at, e.type, e.node].filter(Boolean).join(' · ');
        return li;
      })
    );
    $('push').textContent = view.subscribed
      ? view.delivery + '。通知状态：' + view.notification.map(n => n.status).join(' / ')
      : '未订阅，本设备尚未启用通知';
  } catch (e) {
    $('connection').textContent = e.message + '；当前状态未知，上次成功读取的信息可能已过期';
    for (const b of $('options').children) b.disabled = true;
  }
}
$('pair').onclick = async () => {
  try {
    await request('/sa/device/pair', { code: $('code').value });
    $('code').value = '';
    await refresh();
  } catch (e) {
    $('connection').textContent = e.message;
  }
};
$('notify').onclick = async () => {
  try {
    if (!latest) throw new Error('先完成配对并成功读取');
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if ((await Notification.requestPermission()) !== 'granted') throw new Error('尚未允许通知');
    const bytes = Uint8Array.from(atob(latest.publicKey.replace(/-/g, '+').replace(/_/g, '/')), c =>
      c.charCodeAt(0)
    );
    const subscription =
      (await registration.pushManager.getSubscription()) ||
      (await registration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: bytes,
      }));
    await request('/sa/device/subscription', subscription.toJSON());
    await refresh();
  } catch (e) {
    $('push').textContent = e.message;
  }
};
$('revoke').onclick = () => $('revoke-dialog').showModal();
$('revoke-cancel').onclick = () => $('revoke-dialog').close();
$('revoke-confirm').onclick = async () => {
  if (revokeBusy) return;
  revokeBusy = true;
  $('revoke-confirm').disabled = true;
  try {
    await request('/sa/device/revoke', {});
    csrf = '';
    latest = undefined;
    $('setup').hidden = false;
    $('item').hidden = true;
    $('connection').textContent = '本设备已撤销';
    $('revoke-dialog').close();
  } catch (e) {
    $('connection').textContent = e.message;
  } finally {
    revokeBusy = false;
    $('revoke-confirm').disabled = false;
    $('revoke-cancel').disabled = false;
  }
};
$('refresh').onclick = () => {
  selected = null;
  void refresh();
};
setInterval(() => {
  if (!busy && document.visibilityState === 'visible') void refresh();
}, 10000);
void refresh();
