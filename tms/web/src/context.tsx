import { createContext, useContext } from 'react';

export interface Org { id: string; legal_name: string; role: string; permissions: string[]; entitlements: { planCode: string; status: string; readOnly: boolean; features: string[]; limits: Record<string, number | null> } }
export interface Me { id: string; email: string; fullName: string; emailVerified: boolean; memberships: { tenant_id: string; legal_name: string; role: string; plan_code: string; status: string; signup_intent: any }[] }
export const AppCtx = createContext<{ me: Me; org: Org; reload: () => void; switchTenant: (id: string) => void }>(null as any);
export const useApp = () => useContext(AppCtx);
export const can = (org: Org, p: string) => org.permissions.includes(p);
export const has = (org: Org, f: string) => org.entitlements.features.includes(f);
