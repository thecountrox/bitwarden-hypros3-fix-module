# frida-inject must be executable; the installer resets module files to 0644.
set_perm "$MODPATH/bin/frida-inject" 0 0 0755
