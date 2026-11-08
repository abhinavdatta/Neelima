p = 'src-tauri/src/sec.rs'
data = open(p, 'rb').read()
CR = bytes([13])
LF = bytes([10])
BS = bytes([92])
old = b'"echo keep' + CR + LF + b'rm -rf ~"'
new = b'"echo keep' + BS + b'r' + BS + b'n' + b'rm -rf ~"'
print('matches:', data.count(old))
assert data.count(old) == 1
open(p, 'wb').write(data.replace(old, new))
print('fixed')
