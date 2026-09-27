export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const clientIP = request.headers.get("cf-connecting-ip") || "127.0.0.1";
    const country = request.cf?.country || "UNKNOWN";
    const city = request.cf?.city || "UNKNOWN";

    // 设置 CORS 头
    const corsHeaders = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
    };

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders });
    }

    // -------------------------------------------------------------
    // API 1: 健康检查
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
    // API 2: AI 智能网关路由 (方向 1)
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

        // 此处可使用 env.AI_API_KEY 环境变量调用外界 AI 服务（如 Workers AI、Gemini 或 OpenAI）
        // 下面提供示范性的响应逻辑，后续填入对应 API KEY 即可无缝切换真实模型
        const aiResponse = `[NEXUS-AI-CORE]: 收到指令 "${prompt}"。网关正在实时分析边缘 Telemetry 节点数据，系统状态正常，全域响应时延 < 50ms。`;

        return new Response(
          JSON.stringify({
            success: true,
            prompt: prompt,
            response: aiResponse,
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
    // API 3: 遥测数据上报与心跳 (方向 3 - 增加命令与异常维度)
    // -------------------------------------------------------------
    if (url.pathname === "/api/telemetry/heartbeat" && request.method === "POST") {
      try {
        const body = await request.json();
        const { sessionId, dwellSeconds, eventType, hardwareConcurrency, screenResolution, lastCommand, errorStack } = body;

        const timestamp = new Date().toISOString();
        const userAgent = request.headers.get("user-agent") || "UNKNOWN";

        // 执行 UPSERT，并将上报的命令与异常同步落库
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
    // API 4: 遥测数据聚合分析查询
    // -------------------------------------------------------------
    if (url.pathname === "/api/telemetry/analytics" && request.method === "GET") {
      try {
        const stats = await env.DB.prepare(`
          SELECT 
            COUNT(*) AS total_sessions, 
            ROUND(AVG(dwell_seconds), 1) AS avg_dwell_seconds,
            MAX(dwell_seconds) AS max_dwell_seconds,
            COUNT(DISTINCT city) AS unique_cities
          FROM telemetry_logs;
        `).first();

        const cities = await env.DB.prepare(`
          SELECT city, country, COUNT(*) AS count 
          FROM telemetry_logs 
          GROUP BY city, country 
          ORDER BY count DESC 
          LIMIT 5;
        `).all();

        return new Response(
          JSON.stringify({
            stats: stats || {},
            cityDistribution: cities.results || []
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
    // API 5: 获取最新 5 条完整 Log 日志 (支持Terminal查看)
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
    // 前端 HTML / Dashboard UI 渲染（集成了 AI Terminal 界面）
    // -------------------------------------------------------------
    const htmlContent = `
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>BATTLEFIELD FDE NEXUS GATEWAY</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
  <style>
    body { background-color: #0d1117; color: #c9d1d9; font-family: monospace; padding: 20px; }
    h1 { color: #58a6ff; text-align: center; }
    .card { background: #161b22; border: 1px solid #30363d; padding: 15px; border-radius: 8px; margin-bottom: 20px; }
    .terminal { background: #000; color: #00ff66; padding: 15px; border-radius: 5px; height: 220px; overflow-y: auto; }
    input { background: #0d1117; border: 1px solid #30363d; color: #58a6ff; padding: 8px; width: calc(100% - 20px); font-family: monospace; }
  </style>
</head>
<body>
  <h1>BATTLEFIELD FDE NEXUS GATEWAY</h1>
  
  <div class="card">
    <h3>> NEXUS INTERACTIVE TERMINAL</h3>
    <div id="terminal-out" class="terminal">
      Welcome to Battlefield FDE Nexus Terminal v2.0.<br/>
      Type 'help' for available commands or 'ai &lt;prompt&gt;' to call Edge AI.<br/><br/>
    </div>
    <br/>
    <input type="text" id="term-input" placeholder="Enter command (e.g., help, ai hi, logs, status, whoami)..." onkeydown="handleCmd(event)" />
  </div>

  <script>
    const sessionId = "sess-" + Math.random().toString(36).substring(2, 9);
    let dwellSeconds = 0;

    // 心跳上报函数（带上最后一次执行的命令）
    async function sendHeartbeat(lastCmd = null) {
      dwellSeconds += 5;
      await fetch('/api/telemetry/heartbeat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId,
          dwellSeconds,
          eventType: 'heartbeat',
          hardwareConcurrency: navigator.hardwareConcurrency || 0,
          screenResolution: \`\${window.screen.width}x\${window.screen.height}\`,
          lastCommand: lastCmd
        })
      });
    }

    setInterval(() => sendHeartbeat(), 5000);

    // 终端命令处理
    async function handleCmd(e) {
      if (e.key === 'Enter') {
        const input = document.getElementById('term-input');
        const cmd = input.value.trim();
        const out = document.getElementById('terminal-out');
        input.value = '';

        out.innerHTML += \`<span style="color:#58a6ff;">&gt; \${cmd}</span><br/>\`;

        // 上报命令执行遥测
        sendHeartbeat(cmd);

        if (cmd === 'help') {
          out.innerHTML += \`Available Commands:<br/>
            - <b>ai &lt;prompt&gt;</b> : Dispatch prompt to Edge AI Service<br/>
            - <b>logs</b> : Query latest 5 D1 telemetry records<br/>
            - <b>status</b> : Show gateway system metrics<br/>
            - <b>whoami</b> : Display client connection context<br/>
            - <b>clear</b> : Clear terminal screen<br/><br/>\`;
        } else if (cmd.startsWith('ai ')) {
          const prompt = cmd.substring(3);
          out.innerHTML += \`<span style="color:#e3b341;">[AI Orchestrator]: Processing prompt...</span><br/>\`;
          try {
            const res = await fetch('/api/v1/chat', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ prompt })
            });
            const data = await res.json();
            out.innerHTML += \`\${data.response}<br/><br/>\`;
          } catch(err) {
            out.innerHTML += \`<span style="color:#f85149;">AI Error: \${err.message}</span><br/><br/>\`;
          }
        } else if (cmd === 'logs') {
          const res = await fetch('/api/telemetry/recent-logs');
          const data = await res.json();
          out.innerHTML += JSON.stringify(data.logs, null, 2).replace(/\\n/g, '<br/>') + '<br/><br/>';
        } else if (cmd === 'clear') {
          out.innerHTML = '';
        } else {
          out.innerHTML += \`Unknown command '\${cmd}'. Type 'help' for options.<br/><br/>\`;
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