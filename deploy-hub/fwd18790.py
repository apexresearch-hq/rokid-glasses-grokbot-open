import paramiko, socket, select, threading, sys
HOST, USER, KEY, LPORT, RPORT = '<REDACTED_IP>', 'deploy-user', '/path/to/ssh/private_key', 18790, 18790
client = paramiko.SSHClient()
client.set_missing_host_key_policy(paramiko.AutoAddPolicy())
client.connect(HOST, username=USER, key_filename=KEY, timeout=20)
transport = client.get_transport()
transport.set_keepalive(30)
server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
server.bind(('127.0.0.1', LPORT))
server.listen(40)
print(f'FORWARD ready 127.0.0.1:{LPORT}', flush=True)
def handle(sock):
    try:
        chan = transport.open_channel('direct-tcpip', ('127.0.0.1', RPORT), sock.getpeername())
    except Exception as e:
        print('open_channel', e, flush=True); sock.close(); return
    while True:
        r,_,_ = select.select([sock, chan], [], [], 60)
        if sock in r:
            data = sock.recv(65536)
            if not data: break
            chan.sendall(data)
        if chan in r:
            data = chan.recv(65536)
            if not data: break
            sock.sendall(data)
    chan.close(); sock.close()
while True:
    s, _ = server.accept()
    threading.Thread(target=handle, args=(s,), daemon=True).start()
