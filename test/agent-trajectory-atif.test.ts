// IMPL-095 (R-14b:REC-3 / R-14c:REC-8) — conversores ATIF↔próprio.
//
// ATIF ("Agent Trajectory Interchange Format", RFC 0001 do Harbor) é o formato
// de INTERCÂMBIO de trajetória; o contrato interno continua sendo
// `AgentTrajectory` (`agent-trajectory@2` aceita `source`/`timestamp` por turno).
// Critério: round-trip ATIF→próprio→ATIF preserva mensagens, tool calls, usage,
// stopReason e timestamps — perda 0 nos campos canônicos, com `parseErrors` como
// única perda DECLARADA (entrada ilegível).

import { describe, expect, it } from 'vitest';
import { fromAtif, toAtif, ATIF_SCHEMA_VERSION, type AtifTrajectory } from '../src/agent/trajectory.js';
import type { AgentTrajectory } from '../src/agent/types.js';

/** Fixture ATIF "estrangeiro" (sem `extra.pb` nosso) — RFC 0001 v1.7. */
function fixtureAtif(): AtifTrajectory {
  return {
    schema_version: 'ATIF-v1.7',
    session_id: 'sess-1',
    agent: { name: 'claude-code', version: '1.2.3', model_name: 'anthropic/claude-x' },
    steps: [
      {
        step_id: 1,
        source: 'user',
        message: 'crie hello.txt com "oi"',
        timestamp: '2026-01-15T10:30:00Z',
      },
      {
        step_id: 2,
        source: 'agent',
        message: 'Vou criar o ficheiro.',
        timestamp: '2026-01-15T10:30:02Z',
        reasoning_content: 'Preciso de escrever o ficheiro.',
        tool_calls: [
          {
            tool_call_id: 'call-1',
            function_name: 'write_file',
            arguments: { path: 'hello.txt', content: 'oi' },
          },
        ],
        observation: { results: [{ source_call_id: 'call-1', content: 'ok' }] },
        metrics: { prompt_tokens: 520, completion_tokens: 80, cost_usd: 0.00045 },
        extra: { stop_reason: 'tool_use' },
      },
      {
        step_id: 3,
        source: 'agent',
        message: 'Feito.',
        timestamp: '2026-01-15T10:30:05Z',
        metrics: { prompt_tokens: 100, completion_tokens: 10, cost_usd: 0.0001 },
        extra: { stop_reason: 'completed' },
      },
    ],
    final_metrics: {
      model_name: 'anthropic/claude-x',
      total_prompt_tokens: 620,
      total_completion_tokens: 90,
      total_cached_tokens: 200,
      total_cost_usd: 0.00055,
      total_steps: 3,
      llm_call_count: 2,
    },
    extra: { stop_reason: 'completed' },
  };
}

/**
 * Projeção CANÔNICA de um ATIF — exatamente os campos do critério: mensagens,
 * tool calls, usage, stopReason e timestamps. (`llm_call_count`/`session_id` são
 * identificadores/contegíveis deriváveis, sem casa no formato próprio — ficam
 * declarados no relatório de perda, fora da projeção.)
 */
function canonico(a: AtifTrajectory): unknown {
  return {
    steps: a.steps.map((s) => ({
      step_id: s.step_id,
      source: s.source,
      message: s.message,
      timestamp: s.timestamp,
      reasoning_content: s.reasoning_content,
      tool_calls: (s.tool_calls ?? []).map((c) => ({
        tool_call_id: c.tool_call_id,
        function_name: c.function_name,
        arguments: c.arguments,
      })),
      observation: s.observation,
      metrics: s.metrics,
      stop_reason: s.extra?.stop_reason,
    })),
    usage: a.final_metrics
      ? {
          model_name: a.final_metrics.model_name,
          total_prompt_tokens: a.final_metrics.total_prompt_tokens,
          total_completion_tokens: a.final_metrics.total_completion_tokens,
          total_cached_tokens: a.final_metrics.total_cached_tokens,
          total_cost_usd: a.final_metrics.total_cost_usd,
          total_steps: a.final_metrics.total_steps,
        }
      : undefined,
    stop_reason: a.extra?.stop_reason,
  };
}

describe('IMPL-095 — round-trip ATIF→próprio→ATIF sem perda canônica', () => {
  it('preserva mensagens, tool calls, usage, stopReason e timestamps (perda 0)', () => {
    const atif = fixtureAtif();
    const { trajectory, loss } = fromAtif(atif);

    // A única perda tolerada é a DECLARADA (parseErrors) — e aqui não há nenhuma.
    expect(loss.parseErrors).toBe(0);
    expect(loss.droppedCanonical).toEqual([]);
    expect(trajectory.parseErrors).toBe(0);

    const volta = toAtif(trajectory);
    expect(canonico(volta)).toEqual(canonico(atif));
  });

  it('a volta ao formato próprio é exata (próprio→ATIF→próprio, incl. campos fora do canônico)', () => {
    const atif = fixtureAtif();
    const { trajectory } = fromAtif(atif);
    // Enriquece com campos próprios que não são canônicos do ATIF — eles viajam
    // em `extra.pb` e têm de voltar intactos.
    const rico: AgentTrajectory = {
      ...trajectory,
      usage: {
        ...trajectory.usage,
        tokensReasoning: 7,
        cacheRead: 120,
        cacheWrite: 80,
        costSource: 'usage',
        agentDerivedCostUsd: 0.0005,
      },
      compactions: [{ at: '2026-01-15T10:30:03Z', tokensBefore: 4096 }],
      turns: trajectory.turns.map((t, i) =>
        i === 1
          ? {
              ...t,
              steps: t.steps.map((s) => ({ ...s, ok: true, exitCode: 0, durationMs: 42, outputTruncated: false })),
            }
          : t,
      ),
    };
    const deVolta = fromAtif(toAtif(rico));
    expect(deVolta.loss.droppedCanonical).toEqual([]);
    expect(deVolta.trajectory).toEqual(rico);
  });

  it('emite schema ATIF-v1.7 e o próprio sai como agent-trajectory@2', () => {
    const { trajectory } = fromAtif(fixtureAtif());
    expect(trajectory.format).toBe('agent-trajectory@2');
    const volta = toAtif(trajectory);
    expect(volta.schema_version).toBe(ATIF_SCHEMA_VERSION);
    expect(volta.agent.name).toBe('claude-code');
    expect(volta.agent.model_name).toBe('anthropic/claude-x');
  });

  it('entrada ilegível vira parseErrors DECLARADO (a única perda tolerada), sem derrubar a conversão', () => {
    const atif = fixtureAtif();
    atif.steps.push({ step_id: 99, source: 'agente-typo', message: 'x' } as unknown as AtifTrajectory['steps'][number]);
    atif.steps.push({ message: 'sem id' } as unknown as AtifTrajectory['steps'][number]);
    const { trajectory, loss } = fromAtif(atif);
    expect(loss.parseErrors).toBe(2);
    expect(trajectory.parseErrors).toBe(2);
    expect(trajectory.turns).toHaveLength(3); // as 3 boas continuam aproveitadas
    expect(loss.droppedCanonical).toEqual([]);
  });
});
