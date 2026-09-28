import { useEffect, useState, useSyncExternalStore } from 'react';
import { Download, RotateCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Banner } from './primitives';
import {
  estimateStorage,
  getStorageHealth,
  liveStorageRecord,
  refreshPersistState,
  requestPersistentStorage,
  retrySave,
  storageNoticeContent,
  subscribeStorageHealth,
  type PersistState,
  type StorageHealth,
  type StorageIssue,
  type StorageSubject,
} from '../api';

// Aviso de armazenamento local (IMPL-022): gravação que falhou (a run está SÓ
// na memória desta aba) ou persistência negada pelo navegador. O texto mora em
// storageHealth.ts (puro, testado); aqui só se desenha e se liga às ações.

/** Estado de saúde do armazenamento, reativo. Relê o `persisted()` ao montar. */
export function useStorageHealth(): StorageHealth {
  const health = useSyncExternalStore(subscribeStorageHealth, getStorageHealth, getStorageHealth);
  useEffect(() => {
    void refreshPersistState();
  }, []);
  return health;
}

function downloadJson(filename: string, data: unknown): void {
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadIssue(issue: StorageIssue): void {
  const rec = liveStorageRecord(issue.subject, issue.id);
  if (!rec) return;
  downloadJson(`${issue.subject === 'run' ? 'run' : 'treino'}-${issue.id}.json`, rec);
}

export function StorageNotice({
  targets,
  className,
}: {
  /** Itens da tela; 'all' no Histórico (que não lista o que não foi salvo). */
  targets: ReadonlyArray<{ subject: StorageSubject; id: string }> | 'all';
  className?: string;
}) {
  const health = useStorageHealth();
  const [retrying, setRetrying] = useState(false);
  const notice = storageNoticeContent(health, targets);
  if (!notice) return null;

  async function retryAll(issues: StorageIssue[]) {
    setRetrying(true);
    try {
      // Sucesso limpa o aviso sozinho (storageHealth); falha o mantém.
      await Promise.all(issues.map((i) => retrySave(i.subject, i.id)));
    } finally {
      setRetrying(false);
    }
  }

  const baixaveis = notice.issues.filter((i) => liveStorageRecord(i.subject, i.id));
  return (
    <Banner tone={notice.tone} className={className}>
      <strong>{notice.title}</strong> {notice.body}
      {notice.kind === 'unsaved' && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {baixaveis.map((i) => (
            <Button key={`${i.subject}:${i.id}`} variant="outline" size="sm" onClick={() => downloadIssue(i)}>
              <Download aria-hidden="true" />
              {baixaveis.length > 1
                ? `JSON ${i.subject === 'run' ? 'da run' : 'do treino'} ${i.id.slice(0, 8)}`
                : 'Baixar JSON'}
            </Button>
          ))}
          <Button variant="outline" size="sm" disabled={retrying} onClick={() => void retryAll(notice.issues)}>
            <RotateCw aria-hidden="true" />
            {retrying ? 'Salvando…' : 'Tentar salvar de novo'}
          </Button>
        </div>
      )}
    </Banner>
  );
}

const PERSIST_LABEL: Record<PersistState, { title: string; body: string }> = {
  granted: {
    title: 'Persistente',
    body: 'O navegador não apaga o histórico local de runs sem você pedir.',
  },
  denied: {
    title: 'Não persistente',
    body: 'Sob pressão de espaço (ou, no Safari, depois de dias sem uso) o navegador pode apagar o histórico local. Baixe o JSON das runs que importam.',
  },
  unknown: {
    title: 'Ainda não pedido',
    body: 'O pedido de armazenamento persistente é feito ao iniciar a primeira run.',
  },
  unsupported: {
    title: 'Sem suporte',
    body: 'Este navegador não oferece armazenamento persistente: o histórico local é best-effort.',
  },
};

function formatBytes(n: number): string {
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

/** Seção "Armazenamento local" das Configurações: estado, uso e pedido explícito. */
export function StorageSettings() {
  const health = useStorageHealth();
  const [estimate, setEstimate] = useState<{ usageBytes: number; quotaBytes: number } | undefined>();
  const [asking, setAsking] = useState(false);

  useEffect(() => {
    let vivo = true;
    void estimateStorage().then((e) => vivo && setEstimate(e));
    return () => {
      vivo = false;
    };
  }, [health]);

  const label = PERSIST_LABEL[health.persist];
  const podePedir = health.persist !== 'granted' && health.persist !== 'unsupported';
  const naoSalvos = Object.keys(health.unsaved).length;

  async function ask() {
    setAsking(true);
    try {
      await requestPersistentStorage({ again: true });
    } finally {
      setAsking(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-xl bg-card p-4 ring-1 ring-foreground/10">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="text-sm font-medium">{label.title}</div>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{label.body}</p>
        </div>
        {podePedir && (
          <Button variant="outline" size="sm" disabled={asking} onClick={() => void ask()}>
            Pedir armazenamento persistente
          </Button>
        )}
      </div>
      {estimate && estimate.quotaBytes > 0 && (
        <p className="text-[13px] text-muted-foreground tabular">
          Em uso: {formatBytes(estimate.usageBytes)} de {formatBytes(estimate.quotaBytes)} disponíveis para este site.
        </p>
      )}
      {/* Só o aviso de NÃO SALVOS: o de persistência já é o rótulo acima. */}
      {naoSalvos > 0 && <StorageNotice targets="all" />}
    </div>
  );
}
