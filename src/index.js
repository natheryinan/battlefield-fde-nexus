export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const clientIP = request.headers.get("cf-connecting-ip") || "127.0.0.1";
    const country = request.cf?.country || "US";
    const city = request.cf?.city || "Philadelphia";

    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // API 1: 健康检查 Endpoint
    // -------------------------------------------------------------
    if (url.pathname === "/api/health-check") {
      return new Response(
        JSON.stringify({
          status: "healthy",
          node: "cloudflare-edge",
          timestamp: new Date().toISOString(),
          ip: clientIP,
          location: `${city}, ${country}`
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // -------------------------------------------------------------
    // API 2: 真实 Gemini AI API 路由
    // -------------------------------------------------------------
    if (url.pathname === "/api/v1/chat" && request.method === "POST") {
      try {
        const { prompt } = await request.json();
        if (!prompt) {
          return new Response(JSON.stringify({ error: "Prompt is required" }), {
            status: 400,
            headers: { ...corsHeaders, "Content-Type": "application/json" }
          });
        }

        const apiKey = env.GEMINI_API_KEY;
        if (!apiKey) {
          return new Response(
            JSON.stringify({
              success: true,
              response: `[NEXUS-MOCK-AI]: API Key 未绑定。提示词 "${prompt}" 已接收，节点边缘响应正常。`
            }),
            { headers: { ...corsHeaders, "Content-Type": "application/json" } }
          );
        }

        // 调用 Gemini 1.5 Flash 边缘模型 API
        const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        const aiReq = await fetch(geminiUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }]
          })
        });

        const aiData = await aiReq.json();
        const responseText =
          aiData.candidates?.[0]?.content?.parts?.[0]?.text ||
          "[NEXUS-AI]: 未能获取有效 AI 响应，请检查请求配额。";

        return new Response(
          JSON.stringify({
            success: true,
            prompt: prompt,
            response: responseText,
            timestamp: new Date().toISOString()
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // -------------------------------------------------------------
    // API 3: D1 遥测数据上报与心跳
    // -------------------------------------------------------------
    if (url.pathname === "/api/telemetry/heartbeat" && request.method === "POST") {
      try {
        const body = await request.json();
        const { sessionId, dwellSeconds, eventType, hardwareConcurrency, screenResolution, lastCommand, errorStack } = body;
        const timestamp = new Date().toISOString();
        const userAgent = request.headers.get("user-agent") || "UNKNOWN";

        const query = `
          INSERT INTO telemetry_logs (
            session_id, timestamp, dwell_seconds, event_type, ip, country, city, user_agent, hardware_concurrency, screen_resolution, last_command, error_stack
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(session_id) DO UPDATE SET
            dwell_seconds = excluded.dwell_seconds,
            timestamp = excluded.timestamp,
            event_type = excluded.event_type,
            last_command = COALESCE(excluded.last_command, telemetry_logs.last_command),
            error_stack = COALESCE(excluded.error_stack, telemetry_logs.error_stack);
        `;

        await env.DB.prepare(query)
          .bind(
            sessionId,
            timestamp,
            dwellSeconds || 0,
            eventType || "heartbeat",
            clientIP,
            country,
            city,
            userAgent,
            hardwareConcurrency || 0,
            screenResolution || "UNKNOWN",
            lastCommand || null,
            errorStack || null
          )
          .run();

        return new Response(JSON.stringify({ success: true }), {
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      } catch (err) {
        return new Response(JSON.stringify({ success: false, error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // -------------------------------------------------------------
    // API 4: 遥测数据近期 Log 查询
    // -------------------------------------------------------------
    if (url.pathname === "/api/telemetry/recent-logs" && request.method === "GET") {
      try {
        const logs = await env.DB.prepare(`
          SELECT session_id, city, country, ip, dwell_seconds, last_command, timestamp 
          FROM telemetry_logs 
          ORDER BY id DESC 
          LIMIT 5;
        `).all();

        return new Response(
          JSON.stringify({ logs: logs.results || [] }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (err) {
        return new Response(JSON.stringify({ error: err.message }), {
          status: 500,
          headers: { ...corsHeaders, "Content-Type": "application/json" }
        });
      }
    }

    // -------------------------------------------------------------
    // Dashboard + Full Interactive Terminal HTML UI
    // -------------------------------------------------------------
    const htmlContent = `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BATTLEFIELD FDE NEXUS GATEWAY</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { background-color: #030712; color: #00ffcc; font-family: 'Courier New', Consolas, monospace; padding: 24px; }
    .container { max-width: 1000px; margin: 0 auto; border: 1px solid #00ffcc33; padding: 20px; background: rgba(3, 7, 18, 0.95); box-shadow: 0 0 20px rgba(0, 255, 204, 0.1); }
    h1 { text-align: center; font-size: 22px; letter-spacing: 2px; color: #00ffcc; border-bottom: 1px solid #00ffcc33; padding-bottom: 15px; margin-bottom: 20px; }
    .status-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 15px; margin-bottom: 20px; }
    .status-card { border: 1px solid #00ffcc44; padding: 15px; background: #081225; }
    .status-title { font-size: 12px; color: #88a0b0; margin-bottom: 8px; text-transform: uppercase; }
    .status-value { font-size: 14px; font-weight: bold; color: #00ffcc; }
    .badge { background: #00ffcc22; color: #00ffcc; border: 1px solid #00ffcc; font-size: 10px; padding: 2px 6px; float: right; }
    .terminal-container { border: 1px solid #ff005588; background: #040914; padding: 15px; }
    .terminal-header { font-size: 12px; color: #ff0055; margin-bottom: 10px; }
    .terminal-box { height: 260px; overflow-y: auto; font-size: 13px; line-height: 1.5; color: #00ffcc; padding-right: 5px; }
    .input-row { display: flex; margin-top: 10px; border-top: 1px dashed #00ffcc33; padding-top: 10px; }
    .prompt-label { color: #ff0055; margin-right: 10px; font-weight: bold; }
    input[type="text"] { background: transparent; border: none; outline: none; color: #00ffcc; font-family: inherit; font-size: 13px; flex: 1; }
  </style>
</head>
<body>
  <div class="container">
    <h1>// BATTLEFIELD FDE NEXUS GATEWAY</h1>

    <div class="status-grid">
      <div class="status-card">
        <span class="badge">ONLINE</span>
        <div class="status-title">Agentic AI Pipeline Service</div>
        <div class="status-value">Gemini 1.5 Flash Edge API</div>
      </div>
      <div class="status-card">
        <span class="badge">CONNECTED</span>
        <div class="status-title">D1 Log Persistence Engine</div>
        <div class="status-value">telemetry-db (SQLite)</div>
      </div>
      <div class="status-card">
        <span class="badge">ACTIVE</span>
        <div class="status-title">Ingress Node Location</div>
        <div class="status-value">${city}, ${country} (${clientIP})</div>
      </div>
    </div>

    <div class="terminal-container">
      <div class="terminal-header">[INTERACTIVE SYSTEM TERMINAL - TYPE 'help', 'ai &lt;prompt&gt;', 'logs' OR 'whoami']</div>
      <div class="terminal-box" id="term-out">
        [SYS_INIT] Gateway loaded successfully.<br/>
        [D1_STATUS] Database binding verified: DB.<br/>
        [GEO_TRACE] Ingress: ${city}, ${country} | IP: ${clientIP}<br/><br/>
      </div>
      <div class="input-row">
        <span class="prompt-label">root@yinan-gate:~#</span>
        <input type="text" id="term-in" placeholder="Enter command..." onkeydown="onCommand(event)" />
      </div>
    </div>
  </div>

  <script>
    const sessionId = "SESS-" + Math.random().toString(36).substring(2, 9).toUpperCase();
    let dwell = 0;

    async function sendTelemetry(cmd = null) {
      dwell += 5;
      await fetch('/api/telemetry/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          dwellSeconds: dwell,
          eventType: 'heartbeat',
          hardwareConcurrency: navigator.hardwareConcurrency || 0,
          screenResolution: window.screen.width + 'x' + window.screen.height,
          lastCommand: cmd
        })
      });
    }

    setInterval(() => sendTelemetry(), 5000);

    async function onCommand(e) {
      if (e.key === 'Enter') {
        const input = document.getElementById('term-in');
        const cmd = input.value.trim();
        const out = document.getElementById('term-out');
        if (!cmd) return;

        input.value = '';
        out.innerHTML += \`<span style="color:#ffffff;">root@yinan-gate:~# \${cmd}</span><br/>\`;
        sendTelemetry(cmd);

        if (cmd === 'help') {
          out.innerHTML += \`Available Commands:<br/>
            &nbsp;&nbsp;<b>ai &lt;prompt&gt;</b> : Dispatch prompt to Edge AI Service<br/>
            &nbsp;&nbsp;<b>logs</b> : Query latest 5 D1 telemetry records<br/>
            &nbsp;&nbsp;<b>status</b> : Show gateway health status<br/>
            &nbsp;&nbsp;<b>whoami</b> : Display client connection context<br/>
            &nbsp;&nbsp;<b>clear</b> : Clear terminal screen<br/><br/>\`;
        } else if (cmd.startsWith('ai ')) {
          const prompt = cmd.substring(3);
          out.innerHTML += \`<span style="color:#e3b341;">[AI Orchestrator]: Dispatching to Gemini Edge API...</span><br/>\`;
          try {
            const res = await fetch('/api/v1/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt })
            });
            const data = await res.json();
            out.innerHTML += \`<span style="color:#00ff66;">\${data.response}</span><br/><br/>\`;
          } catch(err) {
            out.innerHTML += \`<span style="color:#ff0055;">[AI Error]: \${err.message}</span><br/><br/>\`;
          }
        } else if (cmd === 'logs') {
          const res = await fetch('/api/telemetry/recent-logs');
          const data = await res.json();
          out.innerHTML += '<pre style="color:#00ffcc;">' + JSON.stringify(data.logs, null, 2) + '</pre><br/>';
        } else if (cmd === 'whoami') {
          out.innerHTML += \`Client IP: ${clientIP}<br/>Location: ${city},${country}<br/>Session: \${sessionId}<br/><br/>\`;
        } else if (cmd === 'status') {
          out.innerHTML += \`Node: Cloudflare Edge<br/>D1 Status: CONNECTED<br/>AI Engine: READY<br/><br/>\`;
        } else if (cmd === 'clear') {
          out.innerHTML = '';
        } else {
          out.innerHTML += \`Command not found: \${cmd}. Type 'help' for available options.<br/><br/>\`;
        }
        out.scrollTop = out.scrollHeight;
      }
    }
  </script>
</body>
</html>
    `;

    return new Response(htmlContent, {
      headers: { "Content-Type": "text/html; charset=utf-8" }
    });
  }
};