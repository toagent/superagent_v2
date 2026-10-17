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
  idle: '当前没有待处理事项',
  unknown: '观察丢失，当前状态未知',
};
async function refresh() {
  try {
    const view = await request('/sa/decisions');
    csrf = view.csrf;
    latest = view;
    $('setup').hidden = true;
    const decisions = view.decisions || (view.decision ? [view.decision] : []);
    let state = selected ? await request('/sa/decisions/' + selected + '/state') : view;
    if (state.stale) {
      selected = decisions.find(d => !d.disabled)?.id || decisions[0]?.id || null;
      state = selected ? await request('/sa/decisions/' + selected + '/state') : view;
    }
    $('inbox-wrap').hidden = !decisions.length;
    $('inbox').replaceChildren();
    for (const entry of decisions) {
      const button = document.createElement('button'),
        question = document.createElement('strong'),
        context = document.createElement('span');
      question.textContent = entry.question;
      context.textContent = entry.context + (entry.disabled ? ' · 需在 Mac 处理' : '');
      button.append(question, context);
      button.setAttribute('aria-current', String(entry.id === (state.decision?.id || selected)));
      button.onclick = async () => {
        selected = entry.id;
        await refresh();
      };
      $('inbox').append(button);
    }
    $('connection').textContent = state.lastRead
      ? '最后成功读取：' + new Date(state.lastRead).toLocaleString()
      : '状态未知；保留上次读取，不推断完成';
    $('state').textContent =
      (statuses[state.status] || '状态未知') +
      (['completed', 'unknown'].includes(state.status) ? '。' + state.note : '');
    $('receipt').textContent = state.receipt
      ? {
          intent: '已保存选择，等待引擎确认',
          accepted: '引擎已接收选择',
          rejected: '决定已变化，未执行；请重读',
          resuming: '引擎已接收选择，正在继续执行',
          unknown: '提交结果未知，请在 Mac 核验；不会自动重发',
        }[state.receipt.stage]
      : state.stale
        ? '旧通知已失效，请回到当前事项'
        : '尚未提交选择';
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
    const notices = view.notification || { accepted: 0, failed: 0, unknown: 0 };
    $('push').textContent =
      (view.subscribed
        ? view.delivery +
          `。通知：已接收 ${notices.accepted}，失败 ${notices.failed}，未知 ${notices.unknown}`
        : '未订阅，本设备尚未启用通知') +
      (view.unknown ? '；另有 ' + view.unknown + ' 个 ledger 当前无法确认' : '');
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
    const notifications = globalThis.Notification;
    if (!notifications)
      throw new Error(
        '此页面模式不支持通知。在 iPhone 上，请先“添加到主屏幕”，再从主屏幕图标打开后重试'
      );
    if (!navigator.serviceWorker) throw new Error('此浏览器不支持通知');
    const registration = await navigator.serviceWorker.register('/sw.js');
    await navigator.serviceWorker.ready;
    if (!registration.pushManager) throw new Error('此浏览器不支持推送通知');
    if ((await notifications.requestPermission()) !== 'granted') throw new Error('尚未允许通知');
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
    $('inbox-wrap').hidden = true;
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
$('refresh').onclick = () => location.reload();
setInterval(() => {
  if (!busy && document.visibilityState === 'visible') void refresh();
}, 10000);
void refresh();
