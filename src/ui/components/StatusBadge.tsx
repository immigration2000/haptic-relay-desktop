import { CircleCheck, CircleOff } from 'lucide-react';

export function StatusBadge({ connected, label }: { connected: boolean; label: string }) {
  const Icon = connected ? CircleCheck : CircleOff;
  return <span className={`status-badge ${connected ? 'connected' : 'disconnected'}`}><Icon size={13} />{label}</span>;
}
