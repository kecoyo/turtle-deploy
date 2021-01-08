const fs = require('fs');
const path = require('path');
const upath = require('upath');
const { EventEmitter } = require('events');
const Promise = require('bluebird');
const minimatch = require('minimatch');

const FtpClient = require('promise-ftp');
const SftpClient = require('ssh2-sftp-client');

const CONNECTED = 'connected';
const DISCONNECTED = 'disconnected';

class FtpDeploy extends EventEmitter {
  constructor(config) {
    super();
    this.config = config;
    this.ftp = config.sftp ? new SftpClient() : new FtpClient();
    this.connectionStatus = DISCONNECTED;
    this.ftp.on('end', this.handleDisconnect);
    this.ftp.on('close', this.handleDisconnect);
  }

  // Connect to the server
  connect() {
    const config = this.config;
    return this.ftp
      .connect(config)
      .then((serverMessage) => {
        this.emit('log', 'Connected to: ' + config.host);
        this.emit('log', 'Connected: Server message: ' + serverMessage);
        this.connectionStatus = CONNECTED;
      })
      .catch((err) => {
        return Promise.reject({
          code: err.code,
          message: 'connect: ' + err.message,
        });
      });
  }

  // Analysing local firstory
  canIncludePath(includes, excludes, filePath) {
    let go = (acc, item) => acc || minimatch(filePath, item, { matchBase: true });
    let canInclude = includes.reduce(go, false);

    // Now check whether the file should in fact be specifically excluded
    if (canInclude) {
      // if any excludes match return false
      if (excludes) {
        let go2 = (acc, item) => acc && !minimatch(filePath, item, { matchBase: true });
        canInclude = excludes.reduce(go2, true);
      }
    }
    // console.log("canIncludePath", include, filePath, res);
    return canInclude;
  }

  // A method for parsing the source location and storing the information into a suitably formated object
  parseLocal(includes, excludes, localRootDir, relDir) {
    // reducer
    let handleItem = (acc, item) => {
      const currItem = path.join(fullDir, item);
      const newRelDir = path.relative(localRootDir, currItem);

      if (fs.lstatSync(currItem).isDirectory()) {
        // currItem is a directory. Recurse and attach to accumulator
        let tmp = this.parseLocal(includes, excludes, localRootDir, newRelDir);
        for (let key in tmp) {
          if (tmp[key].length == 0) {
            delete tmp[key];
          }
        }
        return Object.assign(acc, tmp);
      } else {
        // currItem is a file
        // acc[relDir] is always created at previous iteration
        if (this.canIncludePath(includes, excludes, newRelDir)) {
          // console.log("including", currItem);
          acc[relDir].push(item);
          return acc;
        }
      }
      return acc;
    };

    const fullDir = path.join(localRootDir, relDir);
    // Check if `startDir` is a valid location
    if (!fs.existsSync(fullDir)) {
      throw new Error(fullDir + ' is not an existing location');
    }

    // Iterate through the contents of the `fullDir` of the current iteration
    const files = fs.readdirSync(fullDir);
    // Add empty array, which may get overwritten by subsequent iterations
    let acc = {};
    acc[relDir] = [];
    const res = files.reduce(handleItem, acc);
    return res;
  }
  // Get the list of files to upload
  listFiles() {
    const config = this.config;
    try {
      let filemap = this.parseLocal(config.include, config.exclude, config.localRoot, '/');
      this.emit('log', 'Files found to upload: ' + JSON.stringify(filemap));

      return filemap;
    } catch (e) {
      return Promise.reject(e);
    }
  }

  // Upload file list
  upload(filemap) {
    let keys = Object.keys(filemap);
    return Promise.mapSeries(keys, (key) => {
      return this.makeDirAndUpload(key, filemap[key]);
    });
  }

  // Create remote directory
  makeDir(remoteDir) {
    if (remoteDir === '/') {
      return Promise.resolve('unused');
    } else {
      return this.ftp.mkdir(remoteDir, true);
    }
  }

  // Create a remote directory and upload files
  makeDirAndUpload(relDir, fnames) {
    let config = this.config;
    const remoteDir = upath.join(config.remoteRoot, relDir);
    return this.makeDir(remoteDir).then(() => {
      return Promise.mapSeries(fnames, (fname) => {
        let relFileName = upath.join(relDir, fname);
        let localFileName = upath.join(config.localRoot, relFileName);
        let data = fs.readFileSync(localFileName);
        let eventObject = { filename: relFileName };

        this.emit('uploading', eventObject);

        return this.ftp
          .put(data, upath.join(remoteDir, fname))
          .then(() => {
            this.emit('uploaded', eventObject);
            return Promise.resolve('uploaded ' + localFileName);
          })
          .catch((err) => {
            eventObject.error = err;
            this.emit('upload-error', eventObject);
            // if continue on error....
            return Promise.reject(err);
          });
      });
    });
  }

  handleDisconnect() {
    this.connectionStatus = DISCONNECTED;
  }

  // Delete all files in the remote directory
  deleteRemote() {
    const config = this.config;

    if (!config.deleteRemote) return Promise.resolve(true);

    // 删除目录
    const deleteDir = (ftp, dir) => {
      return ftp.list(dir).then((lst) => {
        let dirNames = lst.filter((f) => f.type == 'd' && f.name != '..' && f.name != '.').map((f) => path.posix.join(dir, f.name));

        let fnames = lst.filter((f) => f.type != 'd').map((f) => path.posix.join(dir, f.name));

        // delete sub-directories and then all files
        return Promise.mapSeries(dirNames, (dirName) => {
          // deletes everything in sub-directory, and then itself
          return deleteDir(ftp, dirName).then(() => ftp.rmdir(dirName));
        }).then(() => Promise.mapSeries(fnames, (fname) => ftp.delete(fname)));
      });
    };

    return deleteDir(this.ftp, config.remoteRoot)
      .then(() => {
        this.emit('log', 'Deleted directory: ' + config.remoteRoot);
        return config;
      })
      .catch((err) => {
        this.emit('log', 'Deleting failed, trying to continue: ' + JSON.stringify(err));
        return Promise.resolve(config);
      });
  }

  deploy() {
    return this.connect()
      .then(this.deleteRemote.bind(this))
      .then(this.listFiles.bind(this))
      .then(this.upload.bind(this))
      .then((res) => {
        this.ftp.end();
        return Promise.resolve(res);
      })
      .catch((err) => {
        console.log('Err', err.message);
        if (this.ftp && this.connectionStatus != DISCONNECTED) this.ftp.end();
        return Promise.reject(err);
      });
  }
}

module.exports = FtpDeploy;
