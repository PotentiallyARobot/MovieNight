/**
 * PromptFlow Interpreter v1.0
 * 
 * Executes .promptflow definition files. A promptflow is a sequence of steps
 * that can be either:
 *   - "code"   : runs a JS function with the current data context
 *   - "prompt" : templates a prompt, calls an LLM endpoint, parses the response
 *
 * The interpreter maintains a data object that accumulates results from each step.
 * Each step's output gets merged into this data object, so later steps can
 * reference earlier results.
 *
 * Usage:
 *   const interpreter = new PromptFlowInterpreter(llmEndpoint);
 *   const result = await interpreter.run(flowDefinition, inputData, { onStep });
 */

class PromptFlowInterpreter {

  /**
   * @param {string} llmEndpoint - URL of the backend LLM proxy
   */
  constructor(llmEndpoint) {
    this.llmEndpoint = llmEndpoint;
  }

  /**
   * Execute a full .promptflow definition
   * 
   * @param {object} flow - Parsed .promptflow JSON
   * @param {object} inputs - Initial input data matching flow.inputs
   * @param {object} [options]
   * @param {function} [options.onStep] - Called with (stepId, status, data) for progress tracking
   * @returns {object} The outputs defined in flow.outputs, extracted from the final data context
   */
  async run(flow, inputs, options = {}) {
    const { onStep, debug } = options;

    // Reset debug log for this run
    this._debugLog = [];

    // The data context — starts with inputs, accumulates step outputs
    let data = { ...inputs };

    for (const step of flow.steps) {
      if (onStep) onStep(step.id, 'start', { description: step.description });

      try {
        let stepOutput;

        if (step.type === 'code') {
          stepOutput = await this._executeCode(step, data);
        } else if (step.type === 'prompt') {
          stepOutput = await this._executePrompt(step, data);
        } else {
          throw new Error(`Unknown step type: "${step.type}" in step "${step.id}"`);
        }

        // Merge step output into data context
        if (stepOutput && typeof stepOutput === 'object') {
          data = { ...data, ...stepOutput };
        }

        if (onStep) onStep(step.id, 'complete', stepOutput);

      } catch (err) {
        if (onStep) onStep(step.id, 'error', { error: err.message });
        // Auto-download debug log on error too
        if (debug !== false) this.downloadDebugLog();
        throw new Error(`PromptFlow step "${step.id}" failed: ${err.message}`);
      }
    }

    // Auto-download debug log after successful run
    if (debug !== false && this._debugLog.length > 0) {
      this.downloadDebugLog();
    }

    // Extract defined outputs
    if (flow.outputs) {
      const result = {};
      for (const [key, spec] of Object.entries(flow.outputs)) {
        result[key] = data[spec.key || key];
      }
      return result;
    }

    return data;
  }

  // ── Code Step Execution ──────────────────────────────────────────────

  async _executeCode(step, data) {
    // Build the function from the code string
    // The code must define either:
    //   function execute(data) { ... }          (sync)
    //   async function execute(data) { ... }    (async)
    const fn = this._buildFunction(step.code);
    const result = await fn(data);
    return result;
  }

  _buildFunction(codeString) {
    // Wrap in an IIFE that returns the execute function
    // This allows the code string to define `function execute(data)`
    // and we extract and call it
    const wrapped = `
      ${codeString}
      return execute;
    `;
    try {
      const factory = new Function(wrapped);
      return factory();
    } catch (err) {
      throw new Error(`Failed to compile code step: ${err.message}`);
    }
  }

  // ── Debug Log ─────────────────────────────────────────────────────
  //
  // Collects every prompt sent and response received during a run.
  // After run() completes, call getDebugLog() to get the full text,
  // or it auto-downloads if debug mode is on.

  _debugLog = [];

  _logPrompt(stepId, prompt, response) {
    const entry = [
      `${'='.repeat(70)}`,
      `STEP: ${stepId}`,
      `TIMESTAMP: ${new Date().toISOString()}`,
      `${'='.repeat(70)}`,
      ``,
      `--- PROMPT SENT (${prompt.length} chars) ---`,
      ``,
      prompt,
      ``,
      `--- RAW RESPONSE ---`,
      ``,
      response,
      ``,
      ``
    ].join('\n');
    this._debugLog.push(entry);
  }

  getDebugLog() {
    return this._debugLog.join('\n');
  }

  downloadDebugLog() {
    if (this._debugLog.length === 0) return;
    const text = this.getDebugLog();
    const blob = new Blob([text], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `promptflow-debug-${new Date().toISOString().slice(0,19).replace(/:/g,'-')}.txt`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }

  // ── Prompt Step Execution ────────────────────────────────────────────

  async _executePrompt(step, data) {
    // 1. Template the prompt
    const prompt = this._templatePrompt(step.template, data);

    // Log the outgoing prompt
    console.log(`[PromptFlow Debug] Step "${step.id}" — prompt (${prompt.length} chars):`);
    console.log(prompt);

    // 2. Call the LLM endpoint
    const response = await fetch(this.llmEndpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ prompt })
    });

    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      this._logPrompt(step.id, prompt, `ERROR: ${err.error || response.status}`);
      throw new Error(err.error || `LLM request failed (${response.status})`);
    }

    const responseData = await response.json();
    let content = responseData.content || '';

    // Log the response
    this._logPrompt(step.id, prompt, content);
    console.log(`[PromptFlow Debug] Step "${step.id}" — response (${content.length} chars):`);
    console.log(content);

    // 3. Parse the response
    let parsed;
    if (step.parse === 'json') {
      parsed = this._parseJSON(content);
    } else {
      parsed = content;
    }

    // 4. Return with the output key
    if (step.outputKey) {
      return { [step.outputKey]: parsed };
    }
    return parsed;
  }

  // ── Template Engine ──────────────────────────────────────────────────
  //
  // Supports:
  //   {{variable}}                    - simple interpolation
  //   {{json variable}}               - JSON.stringify
  //   {{join variable ', ' 'fallback'}} - array join with fallback
  //   {{#if variable}}...{{/if}}      - conditional blocks
  //   {{#each variable}}...{{/each}}  - iteration with {{this}}, {{@index}}, {{@index_1}}

  _templatePrompt(template, data) {
    let result = template;

    // Process {{#each variable}}...{{/each}} blocks
    result = result.replace(
      /\{\{#each\s+(\w+)\}\}([\s\S]*?)\{\{\/each\}\}/g,
      (_, key, body) => {
        const arr = this._resolve(key, data);
        if (!Array.isArray(arr) || arr.length === 0) return '';
        return arr.map((item, i) => {
          let row = body;
          // Replace {{this.prop}} references
          row = row.replace(/\{\{this\.(\w+)\}\}/g, (__, prop) => {
            if (typeof item === 'object' && item !== null) {
              return item[prop] !== undefined ? String(item[prop]) : '';
            }
            return '';
          });
          // Replace {{this}} for simple values
          row = row.replace(/\{\{this\}\}/g, String(item));
          // Replace {{@index}} (0-based) and {{@index_1}} (1-based)
          row = row.replace(/\{\{@index_1\}\}/g, String(i + 1));
          row = row.replace(/\{\{@index\}\}/g, String(i));
          return row;
        }).join('');
      }
    );

    // Process {{#if variable}}...{{/if}} blocks
    result = result.replace(
      /\{\{#if\s+(\w+)\}\}([\s\S]*?)\{\{\/if\}\}/g,
      (_, key, body) => {
        const val = this._resolve(key, data);
        if (val && (!Array.isArray(val) || val.length > 0)) {
          return this._templatePrompt(body, data); // recurse for nested templates
        }
        return '';
      }
    );

    // Process {{json variable}}
    result = result.replace(
      /\{\{json\s+(\w+)\}\}/g,
      (_, key) => {
        const val = this._resolve(key, data);
        return JSON.stringify(val, null, 2);
      }
    );

    // Process {{join variable 'sep' 'fallback'}}
    result = result.replace(
      /\{\{join\s+(\w+)\s+'([^']*)'\s+'([^']*)'\}\}/g,
      (_, key, sep, fallback) => {
        const val = this._resolve(key, data);
        if (Array.isArray(val) && val.length > 0) return val.join(sep);
        return fallback;
      }
    );

    // Process simple {{variable}} interpolation (must come last)
    result = result.replace(
      /\{\{(\w+)\}\}/g,
      (_, key) => {
        const val = this._resolve(key, data);
        if (val === undefined || val === null) return '';
        if (typeof val === 'object') return JSON.stringify(val);
        return String(val);
      }
    );

    return result;
  }

  _resolve(key, data) {
    return data[key];
  }

  // ── JSON Parser (with fallback extraction) ───────────────────────────

  _parseJSON(content) {
    // Clean common LLM wrapping
    let clean = content.trim();

    // Strip markdown code fences
    clean = clean.replace(/^```(?:json)?\s*\n?/i, '').replace(/\n?```\s*$/i, '');
    clean = clean.trim();

    // Try direct parse
    try {
      return JSON.parse(clean);
    } catch (e) {
      // Try to extract JSON object from surrounding text
      const match = clean.match(/\{[\s\S]*\}/);
      if (match) {
        try {
          return JSON.parse(match[0]);
        } catch (e2) {}
      }

      // Try to extract JSON array
      const arrMatch = clean.match(/\[[\s\S]*\]/);
      if (arrMatch) {
        try {
          return JSON.parse(arrMatch[0]);
        } catch (e3) {}
      }

      throw new Error('Failed to parse LLM response as JSON');
    }
  }
}

// Export for use in browser (script tag) or module contexts
if (typeof window !== 'undefined') {
  window.PromptFlowInterpreter = PromptFlowInterpreter;
}
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PromptFlowInterpreter };
}
