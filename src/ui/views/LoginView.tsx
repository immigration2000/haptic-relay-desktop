import { LockKeyhole, Radio, UserRound } from 'lucide-react';

type LoginViewProps = {
  username: string;
  password: string;
  remember: boolean;
  error?: string;
  onUsernameChange(value: string): void;
  onPasswordChange(value: string): void;
  onRememberChange(value: boolean): void;
  onSubmit(): void;
};

export function LoginView(props: LoginViewProps) {
  return (
    <main className="login-screen">
      <section className="login-identity">
        <span className="login-mark"><Radio size={32} /></span>
        <p>HARDWARE MOTION RELAY</p>
        <h1>HAPTIC<br />RELAY</h1>
        <span>RELAY · ROOM BROWSER · HARDWARE CONTROL</span>
      </section>
      <form className="login-panel" onSubmit={event => { event.preventDefault(); props.onSubmit(); }}>
        <div className="login-heading"><span>DESKTOP CLIENT</span><h2>로그인</h2><p>계정으로 로그인하면 방 목록으로 이동합니다.</p></div>
        <label>아이디<div className="input-with-icon"><UserRound size={15} /><input autoFocus value={props.username} onChange={event => props.onUsernameChange(event.target.value)} /></div></label>
        <label>비밀번호<div className="input-with-icon"><LockKeyhole size={15} /><input type="password" value={props.password} onChange={event => props.onPasswordChange(event.target.value)} /></div></label>
        <label className="checkbox-row"><input type="checkbox" checked={props.remember} onChange={event => props.onRememberChange(event.target.checked)} />로그인 유지</label>
        {props.error ? <p className="form-error" role="alert">{props.error}</p> : null}
        <button className="btn btn-primary btn-block" type="submit">로그인</button>
        <p className="login-note">데모 로그인 · 입력한 비밀번호는 저장하지 않습니다.</p>
      </form>
    </main>
  );
}
