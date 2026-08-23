// ----------------------------------------------------------------------------
// Splitter JSONL LF-estrito — NÃO use readline (§14.5 do plano).
//
// O protocolo de stream do executor é "strict LF-delimited JSONL", e o
// `readline` do Node é NÃO-conforme: além de '\n', ele também quebra em
// U+2028/U+2029 — que são CARACTERES VÁLIDOS dentro de uma string JSON. Um
// agente que leia um arquivo contendo um separador de linha Unicode (comum em
// JS minificado e em texto colado de web) faria o `readline` partir o JSON no
// meio, e o parse falharia de forma INTERMITENTE e DEPENDENTE DE CONTEÚDO.
//
// Este splitter quebra SÓ em '\n' (com `indexOf('\n')` + `StringDecoder`), tolera
// um '\r' final e dá flush no `end`. Uma linha inválida NUNCA derruba a
// execução: ela é entregue a `onParseError`, contada em `exec.json.parseErrors`, e
// a execução segue (degradar, nunca derrubar). Se `parseErrors > 0`, o
// `ExecutionRef` é marcado e o dossiê diz quantas linhas se perderam — um dossiê
// montado a partir de um stream parcialmente ilegível não pode se apresentar
// como completo.
// ----------------------------------------------------------------------------
import { StringDecoder } from 'node:string_decoder';

export interface JsonlSplitter {
  push(chunk: Buffer): void;
  end(): void;
}

/**
 * O protocolo JSONL do executor é delimitado por LF e SOMENTE por LF. O
 * `readline` do Node também quebra em U+2028/U+2029, que são CARACTERES VÁLIDOS
 * dentro de uma string JSON — um agente que leia um arquivo com separador
 * Unicode faria o readline partir o JSON no meio, com falha intermitente e
 * dependente de conteúdo. Este splitter quebra só em '\n'.
 */
export function createJsonlSplitter(
  onRecord: (obj: unknown) => void,
  onParseError: (line: string, err: unknown) => void,
): JsonlSplitter {
  const decoder = new StringDecoder('utf8');
  let buffer = '';

  const emit = (raw: string): void => {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (line.trim().length === 0) return;
    try {
      onRecord(JSON.parse(line));
    } catch (err) {
      onParseError(line, err); // degrada: NUNCA derruba
    }
  };

  return {
    push(chunk: Buffer): void {
      buffer += decoder.write(chunk);
      let nl: number;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        emit(buffer.slice(0, nl));
        buffer = buffer.slice(nl + 1);
      }
    },
    end(): void {
      buffer += decoder.end();
      if (buffer.length > 0) {
        emit(buffer);
        buffer = '';
      }
    },
  };
}