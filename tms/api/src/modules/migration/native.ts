import { CanonRow, identityKey } from './pipeline';

/** Profil "native" : relecture de l'export complet de l'application (réversibilité vérifiable). */
export function nativeRows(files: Map<string, Buffer>): CanonRow[] {
  const load = (t: string): any[] => { const b = files.get(`data/${t}.json`); return b ? JSON.parse(b.toString('utf8')) : []; };
  const rows: CanonRow[] = [];
  const push = (entity: CanonRow['entity'], file: string, line: number, data: Record<string, any>) =>
    rows.push({ entity, file, line, key: identityKey(entity, data), data, issues: [] });

  const roles = load('person_roles');
  load('clients').filter((c) => !c.deleted_at && !c.merged_into_id).forEach((c, i) => push('client', 'data/clients.json', i + 1, {
    external_id: c.id, name: c.name, kind: c.kind, siret: c.siret, email: c.billing_email, is_funder: c.is_funder, is_customer: c.status === 'customer',
    address: c.billing_address?.line1 ?? null, postal_code: c.billing_address?.postal_code ?? null, city: c.billing_address?.city ?? null,
  }));
  load('persons').forEach((p, i) => push('person', 'data/persons.json', i + 1, {
    external_id: p.id, first_name: p.first_name, last_name: p.last_name, email: p.email, phone: p.phone,
    role: roles.find((r) => r.person_id === p.id && r.role !== 'contact')?.role ?? roles.find((r) => r.person_id === p.id)?.role ?? 'learner',
  }));
  const versions = load('program_versions');
  load('programs').forEach((p, i) => {
    const v = versions.filter((x) => x.program_id === p.id).sort((a, b) => b.version - a.version)[0];
    push('program', 'data/programs.json', i + 1, {
      external_id: p.id, code: p.code, title: p.title, rncp_code: p.rncp_code, duration_hours: v ? (v.duration_minutes / 60).toFixed(2) : null,
      modality: v?.modality, objectives: v?.objectives, price_ht: v?.price_ht, vat_rate: v?.vat_rate,
    });
  });
  const progOfVersion = new Map(versions.map((v) => [v.id, v.program_id]));
  load('training_sessions').forEach((s, i) => push('session', 'data/training_sessions.json', i + 1, {
    external_id: s.id, program_ref: progOfVersion.get(s.program_version_id), title: s.title, kind: s.kind, client_ref: s.client_id,
    starts_on: s.starts_on, ends_on: s.ends_on, capacity: s.capacity, location: s.location, status: s.status === 'archived' ? 'completed' : s.status,
  }));
  const enrollments = load('enrollments');
  enrollments.forEach((e, i) => push('enrollment', 'data/enrollments.json', i + 1, {
    external_id: e.id, session_ref: e.session_id, person_ref: e.person_id, client_ref: e.client_id, status: e.status,
  }));
  const slots = new Map(load('slots').map((s) => [s.id, s]));
  const enrById = new Map(enrollments.map((e) => [e.id, e]));
  load('attendance').forEach((a, i) => {
    const sl: any = slots.get(a.slot_id); const e: any = enrById.get(a.enrollment_id);
    if (!sl || !e) return;
    push('attendance', 'data/attendance.json', i + 1, {
      external_id: a.id, session_ref: e.session_id, person_ref: e.person_id, starts_at: new Date(sl.starts_at).toISOString(), ends_at: new Date(sl.ends_at).toISOString(),
      status: a.status, minutes: a.minutes,
    });
  });
  load('invoices').filter((x) => x.status === 'issued').forEach((inv, i) => push('invoice', 'data/invoices.json', i + 1, {
    external_id: inv.id, number: inv.number, kind: inv.kind, client_ref: inv.client_id, session_ref: inv.session_id, issue_date: inv.issue_date,
    due_date: inv.due_date, total_ht: inv.total_ht, total_vat: inv.total_vat, total_ttc: inv.total_ttc, currency: inv.currency,
  }));
  const allocs = load('payment_allocations');
  load('payments').forEach((p, i) => push('payment', 'data/payments.json', i + 1, {
    external_id: p.id, client_ref: p.client_id, invoice_ref: allocs.find((a) => a.payment_id === p.id)?.invoice_id ?? null,
    amount: p.amount, received_on: p.received_on, method: p.method, reference: p.reference,
  }));
  load('documents').forEach((d, i) => push('document', 'data/documents.json', i + 1, {
    path: `documents/${d.id}/${d.filename}`, owner_type: ['session', 'enrollment', 'client', 'invoice'].includes(d.owner_type) ? d.owner_type : null,
    owner_ref: d.owner_id, kind: d.kind,
  }));
  return rows;
}
