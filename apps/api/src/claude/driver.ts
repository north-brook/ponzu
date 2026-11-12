/*
 * The script a Claude sign-in runs inside its utility sandbox. `claude setup-token` (the image's,
 * by its path) needs a terminal, so it runs in a private tmux server, 500 columns wide so
 * nothing wraps:
 *
 *   start   starts the sign-in and writes the URL to open to ~/.st/start.out (`URL=…`)
 *   code    pastes the code from ~/.st/code, waits for the token and saves it to ~/.st/token, and
 *           writes `TOKEN_SAVED` and how long it is valid for to ~/.st/code.out; or `NO_TOKEN`
 *           and the screen, with any token on it redacted
 *
 * Everything it says goes to a file of mode 600, never to its output: Vercel keeps a command's
 * output in its logs. The code arrives as a file and the token leaves as one, so neither is ever
 * in a command, an argument or anything the sandbox prints; the terminal's log is shredded once
 * it has the token. The sandbox is created with no credential at all, and the sign-in is started
 * with every Claude variable removed, so nothing can change which account it signs in.
 *
 * It is the tested spike's driver (setup-token-driver.sh), less its verify and diagnosis steps.
 * (In this template `\${` is the shell's `${`, and `\\` its `\`.)
 */
export const SIGN_IN_DRIVER = `#!/usr/bin/env bash
set -u
umask 077
D=~/.st; mkdir -p "$D"; chmod 700 "$D"
T=(tmux -L st)
TOKEN_RE='sk-ant-oat[0-9]+-[A-Za-z0-9_-]{20,}'
redact() { sed -E "s/$TOKEN_RE/<token redacted>/g"; }
screen() { "\${T[@]}" capture-pane -p -J -t st -S -200 2>/dev/null; }

CMD="\${1:-}"
case "$CMD" in start|code) exec >"$D/$CMD.out" 2>&1 ;; esac

case "$CMD" in
start)
  "\${T[@]}" kill-server 2>/dev/null; rm -f "$D/raw.log" "$D/code" "$D/token"
  env -u ANTHROPIC_API_KEY -u ANTHROPIC_AUTH_TOKEN -u CLAUDE_CODE_OAUTH_TOKEN BROWSER=/bin/false \\
    "\${T[@]}" new-session -d -s st -x 500 -y 50 "/opt/ponzu/bin/claude setup-token; echo SETUP_TOKEN_EXIT=\\$?; sleep 900"
  "\${T[@]}" pipe-pane -t st -o "cat >> $D/raw.log"
  for _ in $(seq 1 150); do
    URL=$(grep -aoE 'https://[^[:space:][:cntrl:]]*oauth/authorize\\?[^[:space:][:cntrl:]]+' "$D/raw.log" 2>/dev/null | head -1)
    [ -n "\${URL:-}" ] && break
    URL=$(screen | grep -oE 'https://[^[:space:]]*oauth/authorize\\?[^[:space:]]+' | head -1)
    [ -n "\${URL:-}" ] && break
    sleep 0.2
  done
  if [ -z "\${URL:-}" ]; then echo "NO_URL"; screen | redact | tail -20; exit 1; fi
  echo "URL=$URL"
  ;;
code)
  [ -s "$D/code" ] || { echo "NO_CODE_FILE"; exit 1; }
  "\${T[@]}" load-buffer -b code "$D/code" && "\${T[@]}" paste-buffer -d -b code -t st && "\${T[@]}" send-keys -t st Enter
  shred -u "$D/code" 2>/dev/null || rm -f "$D/code"
  for _ in $(seq 1 150); do
    TOKEN=$(screen | grep -oE "$TOKEN_RE" | head -1)
    [ -n "\${TOKEN:-}" ] && break
    screen | grep -qE 'Invalid code|OAuth error|Failed|SETUP_TOKEN_EXIT=[1-9]' && break
    sleep 0.2
  done
  if [ -z "\${TOKEN:-}" ]; then echo "NO_TOKEN"; screen | redact | grep -v '^[[:space:]]*$' | tail -12; exit 1; fi
  printf '%s' "$TOKEN" > "$D/token"; chmod 600 "$D/token"
  VALID=$(screen | grep -oE 'valid for[^)]*' | head -1)
  "\${T[@]}" clear-history -t st; "\${T[@]}" kill-server 2>/dev/null
  shred -u "$D/raw.log" 2>/dev/null || rm -f "$D/raw.log"
  echo "TOKEN_SAVED \${VALID:-}"
  ;;
*) echo "usage: $0 start|code"; exit 2 ;;
esac
`;
