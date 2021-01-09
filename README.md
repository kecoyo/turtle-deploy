# turtle-ftp-deploy

Using FTP and SFTP to deploy projects.

## Installation

```js
npm install --save-dev turtle-ftp-deploy
```

## Usage

The most basic usage:
```js
var FtpDeploy = require("turtle-ftp-deploy");

var config = {
  host: 'localhost',
  port: 22,
  user: 'root',
  password: '123456',
  localRoot: path.join(__dirname, './public'),
  remoteRoot: '/root/turtle-ftp-deploy/',
  include: ['**/*'],
  exclude: ['*.js.map'],
  backup: true,
  backupRoot: path.join(__dirname, './backup'),
  deleteRemote: true,
  sftp: true,
};

var ftpDeploy = new FtpDeploy(config);

ftpDeploy
  .deploy()
  .then((res) => console.log('finished.'))
  .catch((err) => console.log('err', err));

ftpDeploy.on('log', (data) => console.log('[log]', data));

```
