#!/bin/bash
# The .deb's postrm (package.json's deb.afterRemove). electron-builder fills in the dollar-brace
# names, so the shell's own variables here go without braces.

# electron-builder's own (app-builder-lib/templates/linux/after-remove.tpl), unchanged.
if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
    rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'

if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if apparmor_status --enabled > /dev/null 2>&1; then
    if ! { [ -x '/usr/bin/ischroot' ] && /usr/bin/ischroot; } && hash apparmor_parser 2>/dev/null; then
      apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi

# Removed, not upgraded: an update installs the next .deb over this one.
case "$1" in
  remove|purge) ;;
  *) exit 0 ;;
esac

# The wake helper: `ponzu wake install` (apps/cli/src/wake.ts), which the app runs at launch,
# gives each person who opens it systemd user units that run this package's CLI. They are the
# person's, so root can only reach them where they usually are: ~/.config/systemd/user, with the
# socket stopped too when their systemd is running. A person with XDG_CONFIG_HOME set elsewhere
# keeps theirs; `ponzu wake uninstall` removes them. Units that run another Ponzu (an AppImage's
# copy of its CLI) stay.
getent passwd | while IFS=: read -r user _ _ _ _ home _; do
  units="$home/.config/systemd/user"
  grep -qs "/opt/${sanitizedProductName}/" "$units/ponzu-wake@.service" || continue
  systemctl --user -M "$user@" disable --now ponzu-wake.socket >/dev/null 2>&1 || true
  rm -f "$units/ponzu-wake.socket" "$units/ponzu-wake@.service" "$units/sockets.target.wants/ponzu-wake.socket"
  systemctl --user -M "$user@" daemon-reload >/dev/null 2>&1 || true
done
exit 0
