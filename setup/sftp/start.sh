#!/bin/sh
set -eu
umask 077

# Copy persisted keys to Linux storage with strict permissions, including when
# credentials are mounted from a Windows filesystem.
state=/config/credentials/sftp
mkdir -p "$state/host-keys" /tmp/suitecontainer-sftp-tunnels
key="$state/host-keys/ssh_host_rsa_key"
if [ ! -f "$key" ]; then ssh-keygen -q -t rsa -b 3072 -N '' -f "$key"; fi
cp "$key" /run/sftp/ssh_host_rsa_key
chmod 600 /run/sftp/ssh_host_rsa_key
password=$(node --input-type=module -e '
import { readAuth } from "/opt/suitecontainer/step-auth.js";
const password = readAuth().sftp?.password;
if (!password) throw new Error("Set sftp.password in credentials/auth.json before using SFTP.");
process.stdout.write(password);
')
# Hash on stdin so the password never appears in process arguments or logs.
username=$(node --input-type=module -e 'import { readAuth } from "/opt/suitecontainer/step-auth.js"; process.stdout.write(readAuth().sftp.username);')
current_username=$(getent passwd 1000 | cut -d: -f1)
if [ "$username" != "$current_username" ]; then usermod -l "$username" "$current_username"; fi
password_hash=$(printf '%s\n' "$password" | openssl passwd -6 -stdin)
usermod -p "$password_hash" "$username"
unset password password_hash
cat > /run/sftp/sshd_config <<EOF
Port 8000
ListenAddress 0.0.0.0
HostKey /run/sftp/ssh_host_rsa_key
PidFile /run/sftp/sshd.pid
StrictModes yes
PubkeyAuthentication no
AuthenticationMethods password
PasswordAuthentication yes
KbdInteractiveAuthentication no
UsePAM no
PermitRootLogin no
AllowUsers $username
ChrootDirectory /srv/sftp
ForceCommand internal-sftp -d /files -R
Subsystem sftp internal-sftp
DisableForwarding yes
PermitTTY no
PermitUserRC no
X11Forwarding no
Ciphers aes128-ctr,aes192-ctr,aes256-ctr
LogLevel VERBOSE
EOF
/usr/sbin/sshd -t -f /run/sftp/sshd_config
exec /usr/sbin/sshd -D -e -f /run/sftp/sshd_config
