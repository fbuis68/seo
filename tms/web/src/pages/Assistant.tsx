import { useState } from 'react';
import { Link } from 'react-router-dom';
import { post } from '../api';
import { useAction, useFetch } from '../hooks';

export default function Assistant() {
  const conns = useFetch<any[]>('/api/v1/ai/connections');
  const act = useAction();
  const [conv, setConv] = useState<string | null>(null);
  const [messages, setMessages] = useState<{ role: string; content: string; sources?: any[]; proposals?: any[] }[]>([]);
  const [input, setInput] = useState('');
  const active = conns.data?.filter((c) => c.status === 'active') ?? [];

  const send = async (e: React.FormEvent) => {
    e.preventDefault();
    const content = input.trim(); if (!content) return;
    await act.run(async () => {
      let id = conv;
      if (!id) { id = (await post('/api/v1/ai/conversations', { connectionId: active[0].id })).id; setConv(id); }
      setMessages((m) => [...m, { role: 'user', content }]); setInput('');
      const r = await post(`/api/v1/ai/conversations/${id}/messages`, { content });
      setMessages((m) => [...m, { role: 'assistant', content: r.reply, sources: r.sources, proposals: r.proposals }]);
    });
  };
  const confirmProposal = (p: any) => act.run(() => post(`/api/v1/ai/proposals/${p.id}/confirm`, { payloadHash: p.payload_hash }), (r: any) => setMessages((m) => [...m, { role: 'assistant', content: `Action exécutée : ${JSON.stringify(r.result)}` }]));

  if (conns.data && !active.length) return (
    <><h1>Assistant IA</h1><div className="panel"><p>Connectez votre propre accès OpenAI ou Gemini pour utiliser l’assistant. Les frais du fournisseur sont facturés directement sur votre compte.</p><Link className="btn" to="/settings">Connecter un fournisseur</Link></div></>
  );
  return (
    <>
      <h1>Assistant IA</h1>
      <p className="small muted">Modèle : {active[0]?.provider} / {active[0]?.model}. Les chiffres proviennent du moteur de métriques ; toute création ou envoi vous est soumis pour confirmation.</p>
      <div className="panel">
        <div className="chat" aria-live="polite">
          {messages.length === 0 && <p className="muted">Exemples : « Quel CA facturé cette année ? », « Quelles sessions n’ont pas de convention ? »</p>}
          {messages.map((m, i) => (
            <div key={i} className={`msg ${m.role}`}>{m.content}
              {m.sources?.length ? <div className="small muted">Sources : {m.sources.map((s: any) => s.metric ? `${s.metric} v${s.version} (${s.from} → ${s.to})` : `${s.type} (${s.count})`).join(' · ')}</div> : null}
              {m.proposals?.map((p: any) => (
                <div key={p.id} className="banner" style={{ marginTop: 8 }}>
                  <strong>{p.kind === 'create_session' ? 'Créer la session' : 'Envoyer l’email'}</strong>
                  <pre className="small" style={{ whiteSpace: 'pre-wrap' }}>{JSON.stringify(p.payload, null, 2)}</pre>
                  <button className="btn sm" onClick={() => confirmProposal(p)}>Confirmer</button>{' '}
                  <button className="btn ghost sm" onClick={() => post(`/api/v1/ai/proposals/${p.id}/reject`)}>Refuser</button>
                </div>
              ))}
            </div>
          ))}
        </div>
        <form className="inline" onSubmit={send}>
          <input style={{ flex: 1 }} aria-label="Votre question" value={input} onChange={(e) => setInput(e.target.value)} maxLength={4000} placeholder="Posez votre question…" />
          <button className="btn" disabled={act.busy}>{act.busy ? '…' : 'Envoyer'}</button>
        </form>
        {act.error && <p className="alert">{act.error}</p>}
      </div>
    </>
  );
}
