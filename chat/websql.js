
function SQLTransaction(queue) {
  this.queue = queue;
  this.state = 0;
}

SQLTransaction.prototype = {
  executeSql: function (sqlStatement, args, successCallback, errorCallback) {
    if (this.state !== 0) {
      throw new Error();
    }
    args = args ? JSON.parse(JSON.stringify(args)) : null;
    x = new SQLTransactionQueueItem();
    x.statement = sqlStatement;
    x.args = args;
    x.successCallback = successCallback || null;
    x.errorCallback = errorCallback || null;
    x.isSELECT = /^SELECT\s/i.test(sqlStatement);
    this.queue.push(x);
  }
};

function SQLTransactionQueueItem() {
  this.statement = null;
  this.args = null;
  this.successCallback = null;
  this.errorCallback = null;
  this.isSELECT = false;
}

function SQLError(message, code) {
  Error.call(this, message);
  code = String(code || "");
  var c = SQLError.DATABASE_ERR;
  if (code === "23000") {
    c = SQLError.CONSTRAINT_ERR;
  }
  if (code === "2A000" || code === "37000" || code === "42000") {
    c = SQLError.SYNTAX_ERR;
  }
}

SQLError.UNKNOWN_ERR = 0;
SQLError.DATABASE_ERR = 1;
SQLError.VERSION_ERR = 2;
SQLError.TOO_LARGE_ERR = 3;
SQLError.QUOTA_ERR = 4;
SQLError.SYNTAX_ERR = 5;
SQLError.CONSTRAINT_ERR = 6;
SQLError.TIMEOUT_ERR = 7;

SQLError.prototype = Object.create(Error.prototype);

function SQLResultSet(insertId, rowsAffected, rows) {
  this.insertId = insertId;
  this.rowsAffected = rowsAffected;
  this.rows = rows;
}

function Database(config) {
  this.db = require("mysql2").createConnection(config);
  this.dns = config.database;
  this.expectedVersion = "";
  this.informationTableName = "webdatabase_information";
  this.db.execute("CREATE TABLE IF NOT EXISTS `" + this.informationTableName + "` (`key` VARCHAR(255), `value` VARCHAR(255), PRIMARY KEY (`key`))");
}

Database.prototype = {
  transaction: function (callback, errorCallback, successCallback) {
    this._transactionSteps(callback, errorCallback || null, successCallback || null, null, null);
  },
  changeVersion: function (oldVersion, newVersion, callback, errorCallback, successCallback) {
    this._transactionSteps(callback, errorCallback || null, successCallback || null, oldVersion, newVersion);
  },
  close: function () {
    this.db.end();
  },
  _transactionSteps: function (callback, errorCallback, successCallback, oldVersion, newVersion) {
    var db = this.db;
    var expectedVersion = this.expectedVersion;
    
    var queue = [];//TODO: fix
    //db.execute("START TRANSACTION");
    var t = new SQLTransaction(queue);
    var error = null;
    
    var currentVersion = "";
    var s = db.execute("SELECT value FROM `" + this.informationTableName + "` WHERE `key` = ?", [this.dns], function (e, rows) {
      var c = rows.length > 0 ? rows[0] : null;
      if (c !== null) {
        currentVersion = c.value;
      }
      if (oldVersion !== null && newVersion !== null) {
        if (oldVersion !== currentVersion) {
          error = new SQLError("", SQLError.VERSION_ERR);
        }
      }
      
      if (expectedVersion !== "" && expectedVersion !== currentVersion) {
        error = new SQLError("", SQLError.VERSION_ERR);
      }
      
      if (error === null) {
        if (callback !== null) {
          callback(t);
        }

        var flag = true;
        var executeNext = function () {
          if (flag && queue.length !== 0) {
            var x = queue.shift();
            db.execute(x.statement, x.args, function (e, results) {
              // ... e
              if (e) {
                
              } else {
                if (x.successCallback !== null) {
                  var insertId = results.insertId;
                  var rowsAffected = -1;//...
                  var rows = [];
                  if (x.isSELECT) {
                    var i = -1;
                    while (++i < results.length) {
                      rows[i] = results[i];
                    }
                  }
                  var resultSet = new SQLResultSet(insertId, rowsAffected, rows);
                  var z = x.successCallback;
                  z(t, resultSet);
                }
              }
              executeNext();
            });
          } else {
            t.state = 1;
            var then = function () {
              //db.execute("COMMIT");
              if (successCallback !== null) {
                successCallback();
              }
            };

            if (error === null) {
              if (oldVersion !== null && newVersion !== null) {
                db.execute("REPLACE INTO " + this.informationTableName + "`(`key`, `value`) VALUES (?, ?)", [this.dns, newVersion], function (e, rows) {
                  expectedVersion = newVersion;
                  then();
                });
              } else {
                then();
              }
            } else {
              then();
            }
          }
        };
        executeNext();
        
      }
    });
  }
};

module.exports = {
  Database: Database,
  SQLError: SQLError
};
