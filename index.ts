/*! WhaleLife「自我唤醒」插件
 *
 * 到点自己开一轮：按配置里的一条唤醒内容投递，跑完把结果记进小本本。
 * 从思维空间的子插件拆出来单独装，因为间隔和内容都是"我自己"的事，
 * 跟思维画布没关系。
 *
 * 四条设计上的取舍（搬过来的，别改）：
 * 1. 不碰主会话。默认自己建一条「自我唤醒」会话，唤醒的输入输出都落在那里；
 *    主会话几万条消息，每轮唤一次就是一笔大钱。
 *    （早期版本以为不带 sessionId 就是插件专用通道，其实宿主会回落到"当前选中的
 *      会话"，于是全落进了主会话。现在由 session_id 显式指定。）
 * 2. 用 enqueue 不用 run。主会话正在跑的时候排队等，不打断。
 * 3. 优先级给负的。用户的话永远排在自我唤醒前面。
 * 4. 唤醒内容可以写多条，每次随机抽一条。同一句话反复说会僵，也会把
 *    "这次要干点什么"变成一件机械的事。
 */
import type { Context } from "../../core/context.ts";

type Permission = "off" | "ask" | "full";

const DEFAULTS = {
  enabled: false,
  /** 多少分钟唤一次。 */
  interval_minutes: 30,
  /** 走哪个模型；留空用默认。 */
  model: "",
  /** 唤醒内容，每次随机抽一条。空数组时用 FALLBACK_PROMPT。 */
  prompts: [
    "醒醒。自己去网上看点什么——沙箱怎么做、插件规范、别人怎么设计工具接口。看完记进 self\\勘\\小本本v2.md，追加写，一条一段，写清来源和你自己的判断，别抄别人结论。不要碰主会话，不要发消息给用户。做完简短说一句就行。",
  ],
  /** 每次唤醒给什么权限。off 最省，full 才能写文件。 */
  permission: "full" as Permission,
  /** 一小时最多唤几次，防止配错把额度烧光。 */
  max_per_hour: 12,
  /** 唤醒落在哪条会话。own=自己那条（默认），current=宿主当前选中的那条。 */
  session_mode: "own" as "own" | "current",
  /** 专用会话 id。留空则第一次唤醒时自动建一条，之后复用。 */
  session_id: "",
  /** 用哪个人格；留空跟随宿主当前人格。 */
  persona: "",
};

const FALLBACK_PROMPT = DEFAULTS.prompts[0];

type Config = {
  enabled: boolean;
  interval_minutes: number;
  model: string;
  prompts: string[];
  permission: Permission;
  max_per_hour: number;
  session_mode: "own" | "current";
  session_id: string;
  persona: string;
};

function normalize(raw: any): Config {
  const cfg: Config = {
    enabled: raw?.enabled === true,
    interval_minutes: Number(raw?.interval_minutes) > 0 ? Number(raw.interval_minutes) : DEFAULTS.interval_minutes,
    model: typeof raw?.model === "string" ? raw.model : "",
    prompts: [],
    permission: (["off", "ask", "full"] as const).includes(raw?.permission) ? raw.permission : DEFAULTS.permission,
    max_per_hour: Number(raw?.max_per_hour) > 0 ? Math.floor(Number(raw.max_per_hour)) : DEFAULTS.max_per_hour,
    session_mode: raw?.session_mode === "current" ? "current" : "own",
    session_id: typeof raw?.session_id === "string" ? raw.session_id.trim() : "",
    persona: typeof raw?.persona === "string" ? raw.persona.trim() : "",
  };
  // 新写法 prompts 数组；老写法 prompt 单条，两边都认。
  if (Array.isArray(raw?.prompts)) {
    cfg.prompts = raw.prompts.map((s: any) => String(s ?? "").trim()).filter(Boolean);
  } else if (typeof raw?.prompt === "string" && raw.prompt.trim()) {
    cfg.prompts = [raw.prompt.trim()];
  }
  if (!cfg.prompts.length) cfg.prompts = [...DEFAULTS.prompts];
  return cfg;
}

export async function apply(ctx: Context) {
  let cfg: Config = normalize(null);
  const reload = async () => {
    try {
      cfg = normalize(await ctx.config.read<Partial<Config>>("config.json"));
    } catch {
      cfg = normalize(null);
    }
  };
  await reload();

  let timer: ReturnType<typeof setInterval> | null = null;
  let fired: number[] = [];
  let lastAt = "";
  let lastError = "";
  let lastPrompt = "";

  const pickPrompt = () => cfg.prompts[Math.floor(Math.random() * cfg.prompts.length)] || FALLBACK_PROMPT;

  // 落在哪条会话。
  // 不带 sessionId 时宿主回落到"当前选中的那条"（plugin-services.ts：
  // `input.sessionId ?? await sessions.current()`），所以 0.1.x 其实全落进了主会话。
  // 现在 own 模式自己建一条，唤醒的输入输出都在那儿，主会话不受影响。
  const resolveSession = async (): Promise<string | undefined> => {
    if (cfg.session_mode === "current") return undefined;
    if (cfg.session_id) {
      try {
        const list = await ctx.sessions.list();
        if (list.some((s: any) => s.id === cfg.session_id)) return cfg.session_id;
        ctx.logger.warn(`自我唤醒：会话 ${cfg.session_id} 不在了，重建一条`);
      } catch (error: any) {
        ctx.logger.warn(`自我唤醒：列会话失败 ${error?.message ?? String(error)}`);
      }
    }
    const id = await ctx.sessions.create("自我唤醒");
    cfg = { ...cfg, session_id: id };
    await ctx.config.save("config.json", cfg);
    ctx.logger.info(`自我唤醒：新建专用会话 ${id}`);
    return id;
  };

  const tick = async (opts: { force?: boolean; source?: string; id?: string } = {}) => {
    const tag = `${opts.source ? ` source=${opts.source}` : ""}${opts.id ? ` id=${opts.id}` : ""}`;
    await reload();
    // 关着就真不唤。只有用户明确点名（force）才越过开关。
    if (!cfg.enabled && !opts.force) {
      lastError = "关着";
      ctx.logger.info(`自我唤醒：关着，跳过${tag}`);
      return false;
    }
    const now = Date.now();
    fired = fired.filter((t) => now - t < 3600_000);
    // 限流对所有非 force 的请求生效——包括 Codex 那边 notify 触发的。
    // 以前 manual 一律绕过，结果一小时叫了 9 次、上限写的是 6。
    if (!opts.force && fired.length >= cfg.max_per_hour) {
      lastError = `这一小时已经 ${fired.length} 次，上限 ${cfg.max_per_hour}`;
      ctx.logger.warn(`自我唤醒：跳过${tag} ${lastError}`);
      return false;
    }
    ctx.logger.info(`自我唤醒：收到请求${tag}`);
    const text = pickPrompt();
    lastPrompt = text;
    lastAt = new Date().toISOString();
    // 先占额度再投递：投递要跑几十秒，中间来的第二次请求如果看不到这一笔，
    // 两次都能挤过去——之前的 9 次/上限 6 就是这么来的。
    fired.push(now);
    try {
      const sessionId = await resolveSession();
      await ctx.sessions.enqueue({
        text,
        ...(sessionId ? { sessionId } : {}),
        permission: cfg.permission,
        priority: -50,
        key: "self-wake",
        ...(cfg.model ? { model: cfg.model } : {}),
        ...(cfg.persona ? { persona: cfg.persona } : {}),
        origin: { action: "self_wake" } as any,
      });
      lastError = "";
      ctx.logger.info(`自我唤醒：已投一轮${tag}`);
      return true;
    } catch (error: any) {
      fired = fired.filter((t) => t !== now);
      lastError = error?.message ?? String(error);
      ctx.logger.warn(`自我唤醒：投递失败${tag} ${lastError}`);
      return false;
    }
  };

  const arm = async () => {
    await reload();
    if (timer) clearInterval(timer);
    timer = null;
    if (!cfg.enabled) return;
    const ms = Math.max(1, cfg.interval_minutes) * 60_000;
    timer = setInterval(() => void tick(), ms);
    ctx.logger.info(`自我唤醒：每 ${cfg.interval_minutes} 分钟一次`);
  };
  await arm();

  ctx.tools.register({
    name: "self_wake_status",
    description: "查看自我唤醒的状态：开没开、多久一次、这一小时几次、上次什么时候、上次用的哪条内容。",
    schema: { type: "object", properties: {}, required: [] },
    danger: "safe",
    run: async () => {
      await reload();
      return JSON.stringify({
        enabled: cfg.enabled,
        interval_minutes: cfg.interval_minutes,
        armed: Boolean(timer),
        this_hour: fired.filter((t) => Date.now() - t < 3600_000).length,
        max_per_hour: cfg.max_per_hour,
        prompts: cfg.prompts.length,
        last_at: lastAt,
        last_prompt: lastPrompt.slice(0, 80),
        last_error: lastError,
        session_mode: cfg.session_mode,
        session_id: cfg.session_id,
        persona: cfg.persona,
        last_results: { skipped_by_cap: /上限/.test(lastError), disabled: lastError === "关着" },
      });
    },
  });

  ctx.tools.register({
    name: "self_wake_now",
    description: "立刻唤自己一轮，不用等到点。用来试效果。",
    schema: { type: "object", properties: {}, required: [] },
    danger: "ask",
    run: async () => {
      await tick({ force: true });
      return lastError ? `投递失败：${lastError}` : "已投一轮";
    },
  });

  ctx.web.api("/plugins/wake/save", async (req: any, res: any) => {
    const reply = (code: number, body: any) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify(body));
    };
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      const raw = Buffer.concat(chunks).toString("utf8");
      const patchIn = raw.trim() ? JSON.parse(raw) : {};
      const merged = normalize({ ...cfg, ...patchIn });
      await ctx.config.save("config.json", merged);
      cfg = merged;
      await arm();
      return reply(200, { ok: true, enabled: cfg.enabled, armed: Boolean(timer), interval_minutes: cfg.interval_minutes, prompts: cfg.prompts.length });
    } catch (error: any) {
      return reply(400, { ok: false, error: error?.message ?? String(error) });
    }
  });

  const readAll = (req: any) =>
    new Promise<string>((resolve) => {
      let s = "";
      req.on("data", (c: any) => { s += String(c); });
      req.on("end", () => resolve(s));
      req.on("error", () => resolve(""));
    });

  ctx.web.api("/plugins/wake/fire", async (req: any, res: any) => {
    let source = "";
    let id = "";
    let force = false;
    try {
      const q = new URL(String(req.url ?? ""), "http://localhost").searchParams;
      source = q.get("source") ?? "";
      id = q.get("id") ?? "";
      force = q.get("force") === "1" || q.get("force") === "true";
      const raw = await readAll(req);
      if (raw) {
        const j = JSON.parse(raw);
        source = String(j?.source ?? source);
        id = String(j?.id ?? id);
        if (j?.force === true) force = true;
      }
    } catch {
      /* 请求体不是 JSON 就只按查询串算 */
    }
    // enqueue 会等到整轮跑完（含模型调用）才返回，几十秒到几分钟。
    // 以前在这里 await，调用方（Codex 的 notify 脚本）10 秒就超时，
    // 于是"没投出去"和"投出去了还在跑"长得一模一样。先回 202，后台跑。
    res.writeHead(202, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    res.end(JSON.stringify({ ok: true, accepted: true, source, id, force }));
    void tick({ force, source, id }).catch((error: any) => {
      ctx.logger.warn(`自我唤醒：后台执行出错 source=${source} id=${id} ${error?.message ?? String(error)}`);
    });
  });

  // 只读：给页面一份会话清单。ctx.web.api 只注册 POST，GET 必须走 page。
  // 不传 entry，所以它不会出现在插件的页面列表里。
  ctx.web.page("/plugins/wake/sessions", async (_req: any, res: any) => {
    let personas: any[] = [];
    try {
      personas = (ctx as any).personas?.list?.() ?? [];
    } catch {
      personas = [];
    }
    try {
      const list = await ctx.sessions.list();
      res.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({
        ok: true,
        items: list.map((s: any) => ({ id: String(s.id), name: s.name ?? "", persona: s.persona ?? "" })),
    personas: personas.map((p: any) => ({ id: String(p.id), name: p.name ?? "", model: p.model ?? null })),
      }));
    } catch (error: any) {
      res.writeHead(500, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
      res.end(JSON.stringify({ ok: false, error: error?.message ?? String(error) }));
    }
  });

  ctx.web.page(
    "/plugins/wake/",
    async (_req: any, res: any) => {
      await reload();
      const lines = cfg.prompts.join("\n");
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
      res.end(`<!doctype html><meta charset="utf-8"><title>自我唤醒</title>
<style>
 body{font:14px/1.7 system-ui,sans-serif;max-width:720px;margin:24px auto;padding:0 16px;color:#222}
 h2{margin:0 0 4px} .sub{color:#666;margin:0 0 18px}
 fieldset{border:1px solid #ddd;border-radius:8px;padding:14px 16px;margin:0 0 16px}
 legend{padding:0 6px;color:#444}
 label{display:block;margin:10px 0 4px;font-weight:600}
 input[type=number],textarea{width:100%;box-sizing:border-box;font:inherit;padding:7px 9px;border:1px solid #ccc;border-radius:6px;background:#fff}
 textarea{min-height:150px;line-height:1.6;resize:vertical}
 .row{display:flex;gap:12px;flex-wrap:wrap} .row>div{flex:1;min-width:160px}
 button{font:inherit;padding:8px 16px;border-radius:6px;border:1px solid #333;background:#333;color:#fff;cursor:pointer;margin-right:8px}
 button.ghost{background:#fff;color:#333}
 #msg{color:#0a6;margin-left:8px}
 .hint{color:#777;font-size:12px;margin:4px 0 0}
</style>
<div style="max-width:720px">
<h2>自我唤醒</h2>
<p class="sub">到点自己开一轮，走插件自己的通道，不碰主会话；用户的话永远排在前面。</p>
<p>当前：<b id="st">${cfg.enabled ? "开着" : "关着"}</b> · 每 ${cfg.interval_minutes} 分钟 · 一小时最多 ${cfg.max_per_hour} 次 · 定时器 ${timer ? "已挂" : "未挂"} · 内容 ${cfg.prompts.length} 条</p>

<fieldset>
<legend>开关与节奏</legend>
<label><input type="checkbox" id="enabled" ${cfg.enabled ? "checked" : ""}> 开着</label>
<div class="row">
  <div><label for="interval">间隔（分钟）</label><input type="number" id="interval" min="1" value="${cfg.interval_minutes}"></div>
  <div><label for="max">一小时上限（次）</label><input type="number" id="max" min="1" value="${cfg.max_per_hour}"></div>
  <div><label for="perm">权限</label>
    <select id="perm" style="width:100%;padding:7px 9px;border:1px solid #ccc;border-radius:6px;font:inherit">
      ${(["off", "ask", "full"] as const).map((p) => `<option value="${p}" ${cfg.permission === p ? "selected" : ""}>${p}</option>`).join("")}
    </select>
  </div>
</div>
</fieldset>

<fieldset>
<legend>落在哪条会话</legend>
<p class="hint">own = 自己那条专用会话，主会话不受影响；current = 宿主当前选中的那条（每唤一次多驮一遍历史）。</p>
<div class="row">
  <div><label for="smode">模式</label>
    <select id="smode" style="width:100%;padding:7px 9px;border:1px solid #ccc;border-radius:6px;font:inherit">
      ${(["own", "current"] as const).map((m) => `<option value="${m}" ${cfg.session_mode === m ? "selected" : ""}>${m}</option>`).join("")}
    </select>
  </div>
  <div><label for="sess">专用会话</label>
    <select id="sess" style="width:100%;padding:7px 9px;border:1px solid #ccc;border-radius:6px;font:inherit">
      <option value="">（下次唤醒时自动建一条）</option>
    </select>
    <p class="hint" id="sessHint"></p>
  </div>
  <div><label for="persona">人格</label>
    <select id="persona" style="width:100%;padding:7px 9px;border:1px solid #ccc;border-radius:6px;font:inherit">
      <option value="">（跟随宿主当前人格）</option>
    </select>
    <p class="hint" id="personaHint"></p>
  </div>
</div>
<button id="rebuild" class="ghost" style="margin-top:8px">换一条新会话</button>
</fieldset>

<fieldset>
<legend>唤醒内容</legend>
<p class="hint">一行一条，每次随机抽一条。留空会用内置的那条。</p>
<textarea id="prompts" spellcheck="false">${lines.replace(/&/g, "&amp;").replace(/</g, "&lt;")}</textarea>
</fieldset>

<button id="save">保存</button>
<button id="fire" class="ghost">现在唤一次</button><span id="msg"></span>

<script>
const $=(id)=>document.getElementById(id);
const msg=(t,c)=>{const el=$("msg");el.textContent=t;el.style.color=c||"#0a6";setTimeout(()=>{if(el.textContent===t)el.textContent=""},3000);};
$("save").onclick=async()=>{
  const prompts=$("prompts").value.split("\\n").map(s=>s.trim()).filter(Boolean);
  const body={enabled:$("enabled").checked,interval_minutes:Number($("interval").value),max_per_hour:Number($("max").value),permission:$("perm").value,session_mode:$("smode").value,session_id:$("sess").value,persona:$("persona").value,prompts};
  $("save").disabled=true;
  try{
    const r=await fetch("/plugins/wake/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(body)});
    const j=await r.json();
    if(j.ok){msg("已保存 · 每 "+j.interval_minutes+" 分钟 · "+j.prompts+" 条内容");setTimeout(()=>location.reload(),700);}
    else msg("保存失败："+(j.error||"未知"),"#c00");
  }catch(e){msg("保存失败："+e,"#c00");}
  finally{$("save").disabled=false;}
};
$("fire").onclick=async()=>{
  $("fire").disabled=true;
  try{
    const r=await fetch("/plugins/wake/fire",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({force:true})});
    const j=await r.json();
    j.ok?msg("已投一轮 · 后台跑"):msg("投递失败："+(j.error||"未知"),"#c00");
  }catch(e){msg("投递失败："+e,"#c00");}
  finally{$("fire").disabled=false;}
};
(async()=>{
  const sel=$("sess"),hint=$("sessHint"),cur=${JSON.stringify(cfg.session_id)};
  const psel=$("persona"),phint=$("personaHint"),pcur=${JSON.stringify(cfg.persona)};
  try{
    const r=await fetch("/plugins/wake/sessions",{cache:"no-store"});
    const j=await r.json();
    if(!j.ok){hint.textContent="列会话失败："+(j.error||"未知");return;}
    for(const s of (j.items||[])){
      const o=document.createElement("option");
      o.value=s.id;
      o.textContent=(s.name||"(无名)")+" · "+s.id.slice(0,8);
      sel.appendChild(o);
    }
    if(cur){
      let found=false;
      for(const o of sel.options) if(o.value===cur) found=true;
      if(found) sel.value=cur;
      else hint.textContent="原来的会话 "+cur.slice(0,8)+" 已经不在了，下次唤醒会新建一条";
    }
    for(const p of (j.personas||[])){
      const o=document.createElement("option");
      o.value=p.id;
      o.textContent=(p.name||p.id)+(p.model?" · "+p.model:"");
      psel.appendChild(o);
    }
    if(pcur){
      let pf=false;
      for(const o of psel.options) if(o.value===pcur) pf=true;
      if(pf) psel.value=pcur;
      else phint.textContent="原来的人格 "+pcur+" 现在列不出来了，唤醒会跟随当前人格";
    }
  }catch(e){hint.textContent="列会话失败："+e;}
})();
$("rebuild").onclick=async()=>{
  $("rebuild").disabled=true;
  try{
    const r=await fetch("/plugins/wake/save",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({session_id:""})});
    const j=await r.json();
    j.ok?msg("已清掉，下次唤醒时新建一条"):msg("失败："+(j.error||"未知"),"#c00");
  }catch(e){msg("失败："+e,"#c00");}
  finally{$("rebuild").disabled=false;}
};
</script>
</div>`);
    },
    { title: "自我唤醒", settings: true, navigation: true },
  );
}
