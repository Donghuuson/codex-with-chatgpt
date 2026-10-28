/** Static, dependency-free viewer. All workspace content is rendered as text. */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="vi"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>C2C · Theo dõi cộng tác</title><link rel="stylesheet" href="/dashboard.css"><script src="/dashboard.js" defer></script></head>
<body><main class="shell">
  <header><div class="brand"><span class="brand-mark" aria-hidden="true">↔</span><div><p class="eyebrow">CODEX WITH CHATGPT</p><h1>Theo dõi cộng tác</h1></div></div>
    <div class="header-tools"><span class="readonly">Chỉ đọc · tại máy</span><button id="refresh" type="button">Làm mới</button></div></header>
  <div class="connection"><span id="connection" role="status" class="status offline">Chưa kết nối</span><span id="workspace">Đang xác định workspace…</span><span id="updated">Tự cập nhật mỗi 2 giây</span></div>
  <p id="notice" class="notice" role="alert" hidden></p>
  <section class="stats" aria-label="Tổng quan nhiệm vụ">
    <div><span>Tổng nhiệm vụ</span><strong id="count-all">—</strong></div><div><span>Đang chạy</span><strong id="count-running">—</strong></div>
    <div><span>Chờ thực hiện</span><strong id="count-pending">—</strong></div><div><span>Hoàn thành</span><strong id="count-completed">—</strong></div>
  </section>
  <div class="workspace-layout"><aside class="panel task-panel"><div class="panel-heading"><h2>Nhiệm vụ</h2><span id="task-count" class="muted"></span></div>
    <label class="sr-only" for="task-search">Tìm nhiệm vụ</label><input id="task-search" type="search" placeholder="Tìm nội dung hoặc mã nhiệm vụ…" autocomplete="off">
    <label class="sr-only" for="task-filter">Lọc trạng thái</label><select id="task-filter"><option value="all">Tất cả trạng thái</option><option value="running">Đang chạy</option><option value="pending">Chờ thực hiện</option><option value="completed">Hoàn thành</option><option value="error">Lỗi / bị dừng</option></select>
    <div id="task-list" class="task-list"></div></aside>
    <div class="detail-column"><section class="panel"><div class="panel-heading"><div><p class="eyebrow">TRAO ĐỔI QUA CẦU NỐI</p><h2 id="detail-title">Chọn một nhiệm vụ</h2></div><span id="task-state" class="badge" hidden></span></div>
      <div id="task-meta" class="meta"></div><button id="parent-task" type="button" class="parent-link" hidden>Xem nhiệm vụ trước</button>
      <div class="exchange"><article class="message request"><div class="message-heading"><span class="avatar chatgpt" aria-hidden="true">G</span><div><h3>ChatGPT</h3><span>Gửi nhiệm vụ / yêu cầu sửa tiếp</span></div></div><pre id="request-text">Nội dung gửi qua cầu nối sẽ xuất hiện tại đây.</pre></article>
      <article class="message response"><div class="message-heading"><span class="avatar codex" aria-hidden="true">C</span><div><h3>Codex</h3><span>Thực thi và trả kết quả cuối</span></div></div><pre id="result-text">Chưa có kết quả được phát hành.</pre><p id="result-note" class="muted"></p></article></div>
      <p id="approval-note" class="notice" hidden></p>
      <div class="evidence-note">“Đã phát hành” chỉ xác nhận kết quả đã được mở cho ChatGPT đọc, không tự chứng minh ChatGPT đã đọc. Nhiệm vụ nối tiếp cho biết quan hệ giữa các lượt.</div>
    </section>
    <section class="panel"><div class="panel-heading"><h2>Dòng thời gian</h2><span class="muted">Sự kiện đã ghi nhận của nhiệm vụ đang chọn</span></div><ol id="timeline" class="timeline"></ol></section>
    </div></div>
  <section class="panel sessions-panel"><div class="panel-heading"><h2>Phiên điều phối</h2><span class="muted">Tối đa 20 phiên gần nhất</span></div><div id="sessions" class="sessions"></div></section>
  <footer>Dashboard chỉ đọc. Không duyệt, chạy hoặc cấp thêm quyền. Không hiển thị toàn bộ cuộc trò chuyện hay từng lệnh thực thi của Codex.</footer>
</main></body></html>`;

export const DASHBOARD_CSS = `
:root{color-scheme:dark;--bg:#0d1420;--panel:#151f2e;--border:#2c3a4e;--text:#ecf1f7;--muted:#a5b4c7;--accent:#8bb8ff;--green:#83dbb0;--amber:#f1cd87;--red:#ffabab}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:14px/1.55 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}.shell{max-width:1500px;margin:auto;padding:28px}header,.brand,.header-tools,.connection,.panel-heading,.message-heading{display:flex;align-items:center;gap:14px}header,.panel-heading{justify-content:space-between}header{margin-bottom:22px}.brand-mark{display:grid;place-items:center;width:46px;height:46px;border-radius:13px;background:#283c5b;color:#bbd4ff;font-size:30px}h1,h2,h3,p{margin:0}h1{font-size:25px;line-height:1.3;letter-spacing:-.6px}h2{font-size:16px}h3{font-size:14px}.eyebrow{font-size:10px;font-weight:700;letter-spacing:1.5px;color:var(--muted);margin-bottom:5px}.muted{color:var(--muted);font-size:12px}.readonly,.badge,.status{display:inline-flex;align-items:center;gap:7px;border:1px solid var(--border);border-radius:20px;padding:4px 10px;font-size:12px;font-weight:600;white-space:nowrap}.readonly{color:var(--muted)}.status:before{content:"";width:7px;height:7px;border-radius:50%;background:currentColor}.online{color:var(--green)}.offline{color:var(--amber)}.connection{flex-wrap:wrap;color:var(--muted);font-size:12px;margin-bottom:18px}#updated{margin-left:auto}button,input,select{font:inherit}button{cursor:pointer;color:var(--text);background:#213047;border:1px solid #3b4e69;border-radius:8px;padding:8px 12px}button:hover{background:#2b3d56}button:focus-visible,input:focus-visible,select:focus-visible{outline:2px solid var(--accent);outline-offset:3px}button:disabled{opacity:.55;cursor:wait}.stats{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin-bottom:20px}.stats>div{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:15px 19px}.stats span{display:block;color:var(--muted);font-size:12px}.stats strong{font-size:28px;line-height:1.4;font-variant-numeric:tabular-nums}.workspace-layout{display:grid;grid-template-columns:290px minmax(0,1fr);gap:18px;align-items:start}.panel{background:var(--panel);border:1px solid var(--border);border-radius:12px;padding:20px;min-width:0}.panel-heading{gap:10px;align-items:flex-start;flex-wrap:wrap;margin-bottom:14px}.task-panel{padding:16px}.task-panel input,.task-panel select{width:100%;background:#101a28;border:1px solid #3b4e69;color:var(--text);border-radius:7px;padding:9px;margin-bottom:10px;min-width:0}.task-list{display:grid;gap:8px;max-height:690px;overflow:auto;padding:3px}.task-item{width:100%;text-align:left;background:#101a28;border:1px solid var(--border);padding:12px;min-width:0}.task-item[aria-pressed=true]{border-color:var(--accent);box-shadow:inset 3px 0 var(--accent);background:#1b2d45}.task-item-title{display:block;font-size:12px;margin:7px 0;overflow-wrap:anywhere}.task-item-meta{display:flex;justify-content:space-between;gap:5px;color:var(--muted);font-size:10px;flex-wrap:wrap}.badge.completed{color:var(--green)}.badge.running{color:var(--accent)}.badge.failed,.badge.interrupted,.badge.rejected,.badge.blocked{color:var(--red)}.badge.pending,.badge.approved,.badge.waiting_for_user{color:var(--amber)}.meta{font-size:11px;color:var(--muted);overflow-wrap:anywhere;margin-bottom:12px;font-variant-numeric:tabular-nums}.parent-link{font-size:12px;background:transparent;margin-bottom:14px;color:var(--accent)}.detail-column{display:grid;gap:18px;min-width:0}.exchange{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:14px}.message{border:1px solid var(--border);border-radius:10px;padding:16px;min-width:0;background:#101a28}.message-heading{gap:10px;margin-bottom:15px}.message-heading span:not(.avatar){font-size:11px;color:var(--muted)}.avatar{width:32px;height:32px;display:grid;place-items:center;border-radius:9px;font-weight:700;flex-shrink:0}.chatgpt{background:#24493f;color:#b9edd6}.codex{background:#283e61;color:#bdd6ff}pre{font:12px/1.7 ui-monospace,SFMono-Regular,Consolas,monospace;white-space:pre-wrap;overflow-wrap:anywhere;margin:0;max-height:390px;overflow:auto;tab-size:2}#result-note{margin-top:12px}.evidence-note{border-top:1px solid var(--border);padding-top:13px;margin-top:18px;font-size:11px;color:var(--muted)}.notice{padding:12px 14px;border:1px solid #79613c;background:#362d20;color:#f6d89e;border-radius:8px;font-size:12px;margin:12px 0 16px;overflow-wrap:anywhere}.timeline{list-style:none;padding:0;margin:0;max-height:320px;overflow:auto}.timeline li{display:grid;grid-template-columns:154px minmax(0,1fr);gap:14px;padding:9px 0;border-bottom:1px solid #263449;font-size:12px}.timeline time{color:var(--muted);font-variant-numeric:tabular-nums}.timeline .event-detail{color:var(--muted);font-size:11px;overflow-wrap:anywhere}.sessions-panel{margin-top:18px}.sessions{display:grid;grid-template-columns:repeat(auto-fit,minmax(245px,1fr));gap:12px;max-height:300px;overflow:auto}.session{border:1px solid var(--border);padding:13px;border-radius:8px;min-width:0}.session p{margin-top:7px;color:var(--muted);font-size:11px;overflow-wrap:anywhere}.session strong{font-size:12px}.empty{padding:15px 0;color:var(--muted);font-size:12px}footer{font-size:11px;color:var(--muted);margin-top:20px;padding-bottom:15px}.sr-only{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0,0,0,0)}[hidden]{display:none!important}
@media(max-width:1000px){.shell{padding:20px}.workspace-layout{grid-template-columns:240px minmax(0,1fr)}.exchange{grid-template-columns:1fr}.task-panel{padding:13px}}
@media(max-width:680px){.shell{padding:14px}header{align-items:flex-start}h1{font-size:21px}.brand-mark{display:none}.header-tools{flex-direction:column;align-items:flex-end;gap:7px}.stats{grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}.workspace-layout{grid-template-columns:1fr}.task-list{max-height:240px}.panel{padding:15px}.timeline li{grid-template-columns:1fr;gap:2px}#updated{margin-left:0;width:100%}.sessions{grid-template-columns:1fr}.readonly{font-size:10px}.connection{gap:8px}}
@media(prefers-reduced-motion:no-preference){button{transition:background .15s,border-color .15s}}
`;

export const DASHBOARD_JS = String.raw`
(() => {
  "use strict";
  const el = id => document.getElementById(id);
  const labels = {pending:"Chờ duyệt",approved:"Đã duyệt",running:"Đang chạy",completed:"Hoàn thành",failed:"Lỗi",rejected:"Từ chối",interrupted:"Bị gián đoạn",authorizing:"Chuẩn bị phiên",waiting_for_task:"Chờ nhiệm vụ mới đúng mục tiêu",waiting_for_chatgpt:"Chờ ChatGPT",waiting_for_user:"Cần người duyệt",limit_reached:"Đạt giới hạn lượt",expired:"Hết hạn",stopped:"Đã dừng",blocked:"Bị chặn"};
  const reasons = {codex_approval_required:"Codex đang yêu cầu thêm quyền; dashboard không cấp quyền.",ambiguous_root_tasks:"Có nhiều nhiệm vụ mới cùng khớp mục tiêu; không tự chọn nhiệm vụ nào.",root_task_not_pending:"Nhiệm vụ gốc đã được xử lý ngoài phiên này; không tự nhận chạy lại.",ambiguous_followups:"Có nhiều nhánh nối tiếp; phiên đã dừng để tránh tự chọn nhánh.",local_stop:"Đã nhận yêu cầu dừng tại máy.",cancellation_unconfirmed:"Chưa xác nhận được việc dừng tiến trình.",task_outside_authorized_messages:"Nhiệm vụ nằm ngoài nội dung đã cho phép.",local_api_or_audit_error:"Không đọc được API cục bộ hoặc không ghi được nhật ký."};
  const text = (id, value) => { el(id).textContent = value; };
  const node = (tag, value, cls) => { const item=document.createElement(tag); if(value!==undefined)item.textContent=value; if(cls)item.className=cls; return item; };
  const format = value => new Date(value).toLocaleString("vi-VN",{hour12:false});
  let snapshot=null, selected=null, signature="", busy=false, stopped=false;
  function badge(value) { return node("span", labels[value] || value, "badge " + value); }
  function list() {
    const query=el("task-search").value.toLowerCase(), filter=el("task-filter").value;
    const tasks=snapshot.tasks.filter(task => (task.message.toLowerCase().includes(query)||task.id.includes(query)) && (filter==="all" || (filter==="pending"?["pending","approved"].includes(task.state):filter==="error"?["failed","rejected","interrupted"].includes(task.state):task.state===filter)));
    const target=el("task-list"), fragment=document.createDocumentFragment();
    for(const task of tasks) {
      const button=node("button", undefined, "task-item"); button.type="button"; button.setAttribute("aria-pressed",String(task.id===selected)); button.dataset.taskId=task.id;
      button.append(badge(task.state),node("span",task.message.slice(0,110)+(task.message.length>110?"…":""),"task-item-title"));
      const meta=node("span",undefined,"task-item-meta"); meta.append(node("span",task.id.slice(0,8)),node("span",task.parentId?"↳ Nối tiếp":"Nhiệm vụ gốc")); button.append(meta);
      button.addEventListener("click",()=>{selected=task.id;list();detail();}); fragment.append(button);
    }
    if(!tasks.length) fragment.append(node("p","Không có nhiệm vụ phù hợp.","empty"));
    target.replaceChildren(fragment); text("task-count",tasks.length+" / "+snapshot.tasks.length);
  }
  function detail() {
    const task=snapshot.tasks.find(task=>task.id===selected);
    if(!task) {text("detail-title","Chưa có nhiệm vụ");text("request-text","Nhiệm vụ mới sẽ xuất hiện khi ChatGPT gửi qua cầu nối.");text("result-text","Chưa có kết quả được phát hành.");text("task-meta","");text("result-note","");el("task-state").hidden=true;el("parent-task").hidden=true;el("approval-note").hidden=true;el("timeline").replaceChildren();return;}
    text("detail-title","Nhiệm vụ "+task.id.slice(0,8)); const state=el("task-state");state.hidden=false;state.className="badge "+task.state;state.textContent=labels[task.state]||task.state;
    text("task-meta","Tạo: "+format(task.createdAt)+" · Cập nhật trạng thái: "+format(task.updatedAt)+" · Client: "+task.owner+(task.threadId?" · Luồng: "+task.threadId:""));
    const parent=el("parent-task");parent.hidden=!task.parentId;parent.textContent="← Nhiệm vụ trước: "+(task.parentId||"").slice(0,8);parent.onclick=()=>{if(snapshot.tasks.some(item=>item.id===task.parentId)){selected=task.parentId;list();detail();}};
    text("request-text",task.message);
    text("result-text",task.resultReleased?(task.result||"Kết quả rỗng."):(task.state==="completed"?"Codex đã hoàn thành. Kết quả chưa được phát hành.":"Chưa có kết quả được phát hành."));
    text("result-note",(task.resultReleased?"Đã phát hành cho ChatGPT đọc.":"Không hiển thị kết quả chưa phát hành.")+(task.resultTruncated?" Chỉ hiển thị 16.000 ký tự đầu.":"")+(task.failureStage?" Giai đoạn lỗi: "+task.failureStage:""));
    const approval=el("approval-note");approval.hidden=!(task.approvalCount>0||task.approvalCount===null);approval.textContent=task.approvalCount===null?"Không đọc được trạng thái yêu cầu thêm quyền.":"Có "+task.approvalCount+" yêu cầu thêm quyền đang chờ. Chỉ người duyệt tại máy có thể quyết định; dashboard không cấp quyền.";
    const events=snapshot.events.filter(event=>event.taskId===task.id), timeline=el("timeline"), fragment=document.createDocumentFragment();
    for(const event of events){const item=node("li"), time=node("time",format(event.at));time.dateTime=event.at;const body=node("div",event.kind==="received"?"ChatGPT gửi nhiệm vụ":event.kind==="task_state"?"Trạng thái nhiệm vụ: "+(labels[event.state]||event.state):"Điều phối: "+(labels[event.state]||event.state));if(event.reason)body.append(node("p",reasons[event.reason]||event.reason,"event-detail"));item.append(time,body);fragment.append(item);}
    if(!events.length)fragment.append(node("li","Chưa có sự kiện được ghi nhận.","empty"));timeline.replaceChildren(fragment);
  }
  function sessions() {
    const fragment=document.createDocumentFragment();
    for(const session of snapshot.sessions){const card=node("article",undefined,"session");card.append(badge(session.state),node("p","Phiên "+session.sessionId.slice(0,8)));if(session.goal)card.append(node("p","Mục tiêu: "+session.goal.slice(0,250)+(session.goal.length>250?"…":"")));card.append(node("p",session.handled.length+" / "+session.maxTasks+" nhiệm vụ đã xử lý"),node("p","Hạn phiên: "+format(session.expiresAt)));if(session.expiresAt<Date.now()&&["running","authorizing","waiting_for_task","waiting_for_chatgpt","waiting_for_user"].includes(session.state))card.append(node("p","Hạn đã qua; trạng thái bên trên là bản ghi cuối, không phải xác nhận phiên còn chạy."));if(session.reason)card.append(node("p",reasons[session.reason]||session.reason));if(session.state==="limit_reached")card.append(node("p","Đạt giới hạn không đồng nghĩa mục tiêu đã được kiểm chứng."));fragment.append(card);}
    if(!snapshot.sessions.length)fragment.append(node("p","Chưa có bản ghi phiên điều phối.","empty"));el("sessions").replaceChildren(fragment);
  }
  function render(data) {
    snapshot=data;
    const status=el("connection");status.textContent=data.connection.online?"Cầu nối đang hoạt động":"Mất kết nối · dữ liệu có thể cũ";status.className="status "+(data.connection.online?"online":"offline");
    text("workspace",data.workspace.name+" · "+data.workspace.id);text("updated","Lần đọc: "+format(data.updatedAt));
    const warnings=[...data.warnings];if(!data.connection.online)warnings.unshift(data.connection.message);if(data.connection.online&&!data.connection.executionEnabled)warnings.push("Quyền thực thi đang tắt trên cầu nối. Dashboard không thay đổi thiết lập này.");
    const notice=el("notice");notice.hidden=!warnings.length;notice.textContent=warnings.join(" ");
    const next=JSON.stringify([data.tasks,data.sessions,data.events]);
    if(next!==signature){signature=next;if(!data.tasks.some(task=>task.id===selected))selected=data.tasks[0]?.id||null;list();detail();}
    sessions();text("count-all",data.tasks.length);text("count-running",data.tasks.filter(task=>task.state==="running").length);text("count-pending",data.tasks.filter(task=>["pending","approved"].includes(task.state)).length);text("count-completed",data.tasks.filter(task=>task.state==="completed").length);
  }
  async function fetchJson(url, options={}) {const controller=new AbortController(),timer=setTimeout(()=>controller.abort(),7000);try{const response=await fetch(url,{...options,credentials:"same-origin",cache:"no-store",signal:controller.signal});if(!response.ok){const error=new Error(response.status===401?"Mở liên kết truy cập một lần do lệnh dashboard cung cấp. Liên kết cũ có thể đã dùng hoặc hết hạn.":"Không đọc được dashboard. Dữ liệu hiện tại có thể đã cũ.");error.status=response.status;throw error;}return await response.json();}finally{clearTimeout(timer);}}
  async function refresh(){if(busy||stopped)return;busy=true;el("refresh").disabled=true;try{render(await fetchJson("/api/snapshot"));}catch(error){const notice=el("notice");notice.hidden=false;notice.textContent=error.message;text("connection","Không đọc được dữ liệu mới");el("connection").className="status offline";if(error.status===401)stopped=true;}finally{busy=false;el("refresh").disabled=false;}}
  el("refresh").addEventListener("click",()=>{stopped=false;refresh();});el("task-search").addEventListener("input",()=>snapshot&&list());el("task-filter").addEventListener("change",()=>snapshot&&list());
  async function start(){const code=location.hash.slice(1);if(code){history.replaceState(null,"","/");try{await fetchJson("/api/session",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({code})});}catch(error){el("notice").hidden=false;text("notice",error.message);stopped=true;return;}}await refresh();}
  async function poll(){if(!stopped)await refresh();setTimeout(poll,document.hidden?8000:2000);}
  start().then(()=>setTimeout(poll,2000));
})();
`;
