// server.js - OpenAI to NVIDIA NIM API Proxy
// server.js - OpenAI to NVIDIA NIM API Proxy (Vercel-ready)
// server.js - OpenAI to NVIDIA NIM API Proxy (Vercel-ready)
// server.js - OpenAI to NVIDIA NIM API Proxy (Vercel-ready)
// server.js - OpenAI to NVIDIA NIM API Proxy (Vercel-ready)
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use(express.urlencoded({ limit: '50mb', extended: true }));
app.use((req, res, next) => {
  console.log(`${req.method} ${req.originalUrl}`);
  next();
});

const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = (process.env.NIM_API_KEY || '').trim();

const SHOW_REASONING = false;

// Change this to switch the default model
const DEFAULT_MODEL = 'moonshotai/kimi-k3';

const MODEL_MAPPING = {
  'gpt-3.5-turbo': DEFAULT_MODEL,
  'gpt-4': DEFAULT_MODEL,
  'gpt-4-turbo': DEFAULT_MODEL,
  'gpt-4o': DEFAULT_MODEL,
  'claude-3-opus': DEFAULT_MODEL,
  'claude-3-sonnet': DEFAULT_MODEL,
  'gemini-pro': DEFAULT_MODEL
};

const MAX_CHARS = 20000;
const MAX_SYSTEM_CHARS = 10000;

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    model: DEFAULT_MODEL,
    api_key_set: !!NIM_API_KEY
  });
});

app.get('/v1/models', (req, res) => {
  res.json({
    object: 'list',
    data: Object.keys(MODEL_MAPPING).map(id => ({
      id,
      object: 'model',
      created: Math.floor(Date.now() / 1000),
      owned_by: 'nvidia-nim-proxy'
    }))
  });
});

// TEMPORARY test page - delete after debugging
app.get('/test', async (req, res) => {
  const model = req.query.model || 'moonshotai/kimi-k3';
  try {
    const r = await axios.post(`${NIM_API_BASE}/chat/completions`, {
      model,
      messages: [{ role: 'user', content: 'say hi' }],
      max_tokens: 50
    }, {
      headers: { 'Authorization': `Bearer ${NIM_API_KEY}`, 'Content-Type': 'application/json' },
      timeout: 240000
    });
    res.json({ ok: true, model, reply: r.data.choices?.[0]?.message });
  } catch (e) {
    res.json({
      ok: false,
      model,
      status: e.response?.status,
      nvidia_said: e.response?.data || e.message
    });
  }
});

app.post(/chat\/completions\/?$/, async (req, res) => {
  try {
    const { model, messages, max_tokens, stream } = req.body;
    const nimModel = MODEL_MAPPING[model] || model || DEFAULT_MODEL;

    const textOf = (m) => (typeof m.content === 'string' ? m.content : '');

    const systemMsgs = messages
      .filter(m => m.role === 'system')
      .map(m => ({ ...m, content: textOf(m).slice(0, MAX_SYSTEM_CHARS) }));

    const chatMsgs = messages.filter(m => m.role !== 'system');

    const total = () =>
      [...systemMsgs, ...chatMsgs].reduce((n, m) => n + textOf(m).length, 0);

    while (chatMsgs.length > 2 && total() > MAX_CHARS) {
      chatMsgs.shift();
    }

    const finalMessages = [...systemMsgs, ...chatMsgs];

    console.log('model:', nimModel, '| messages:', finalMessages.length, '| chars:', total());

    const nimRequest = {
      model: nimModel,
      messages: finalMessages,
      temperature: 0.9,

    
      max_tokens: Math.min(max_tokens || 1024, 4096),
      stream: !!stream
    };

    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      timeout: 240000
    });

    if (stream) {
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache, no-transform');
      res.setHeader('Connection', 'keep-alive');
      res.setHeader('X-Accel-Buffering', 'no');
      res.flushHeaders();

      const keepAlive = setInterval(() => res.write(': keep-alive\n\n'), 10000);
      res.on('close', () => clearInterval(keepAlive));

      let buffer = '';
      let reasoningStarted = false;

      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        lines.forEach(line => {
          if (!line.startsWith('data: ')) return;

          if (line.includes('[DONE]')) {
            res.write('data: [DONE]\n\n');
            return;
          }

          try {
            const data = JSON.parse(line.slice(6));
            const delta = data.choices?.[0]?.delta;

            if (delta) {
              const reasoning = delta.reasoning_content || delta.reasoning;
              const content = delta.content;

              if (SHOW_REASONING) {
                let combined = '';
                if (reasoning && !reasoningStarted) {
                  combined = '<think>\n' + reasoning;
                  reasoningStarted = true;
                } else if (reasoning) {
                  combined = reasoning;
                }
                if (content && reasoningStarted) {
                  combined += '</think>\n\n' + content;
                  reasoningStarted = false;
                } else if (content) {
                  combined += content;
                }
                delta.content = combined;
              } else {
                delta.content = content || '';
              }
              delete delta.reasoning_content;
              delete delta.reasoning;
            }

            res.write(`data: ${JSON.stringify(data)}\n\n`);
          } catch (e) {
            res.write(line + '\n\n');
          }
        });
      });

      response.data.on('end', () => {
        clearInterval(keepAlive);
        res.end();
      });

      response.data.on('error', (err) => {
        clearInterval(keepAlive);
        console.error('Stream error:', err.message);
        res.end();
      });
    } else {
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';
          const reasoning = choice.message?.reasoning_content || choice.message?.reasoning;

          if (SHOW_REASONING && reasoning) {
            fullContent = '<think>\n' + reasoning + '\n</think>\n\n' + fullContent;
          }

          return {
            index: choice.index,
            message: { role: choice.message.role, content: fullContent },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };

      res.json(openaiResponse);
    }
  } catch (error) {
    let detail = error.response?.data;
    if (detail && typeof detail.on === 'function') {
      detail = await new Promise((resolve) => {
        let s = '';
        detail.on('data', (c) => (s += c.toString()));
        detail.on('end', () => resolve(s));
        detail.on('error', () => resolve(s));
      });
    }
    console.error('Proxy error:', error.message, '| NVIDIA said:', JSON.stringify(detail));

    if (res.headersSent) return res.end();

    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

if (process.env.VERCEL !== '1') {
  app.listen(PORT, () => {
    console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  });
}

module.exports = app;
