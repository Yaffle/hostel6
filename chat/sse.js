/*jslint sloppy: true, white: true, maxerr: 50, indent: 2 */
/*global require, setTimeout, clearTimeout, setInterval */

/*

8 Notes

Legacy proxy servers are known to, in certain cases, drop HTTP connections after a short timeout. To protect against such proxy servers, authors can include a comment line (one starting with a ':' character) every 15 seconds or so.

Authors wishing to relate event source connections to each other or to specific documents previously served might find that relying on IP addresses doesn't work, as individual clients can have multiple IP addresses (due to having multiple proxy servers) and individual IP addresses can have multiple clients (due to sharing a proxy server). It is better to include a unique identifier in the document when it is served and then pass that identifier as part of the URL when the connection is established.

Authors are also cautioned that HTTP chunking can have unexpected negative effects on the reliability of this protocol. Where possible, chunking should be disabled for serving event streams unless the rate of messages is high enough for this not to matter.

Clients that support HTTP's per-server connection limitation might run into trouble when opening multiple pages from a site if each page has an EventSource to the same domain. Authors can avoid this using the relatively complex mechanism of using unique domain names per connection, or by allowing the user to enable or disable the EventSource functionality on a per-page basis, or by sharing a single EventSource object using a shared worker. [WEBWORKERS]

*/

/*
process.on('uncaughtException', function (e) {
  try {
    addMessage('server', 'Caught exception: ' + e + ' ' + (typeof(e) === 'object' ? e.stack : ''), '', '');
  } catch(e0) {} //?
});
*/

var dbConfig = require("./config.js");
var http = require('http');
var https = require('https');
var sys = require('sys');
var fs = require('fs');

var EventEmitter = require('events').EventEmitter;
var emitter = new EventEmitter();

var querystring = require('querystring');
//emitter.setMaxListeners(0);//http://nodejs.ru/doc/v0.3.x/events.html#emitter.setMaxListeners???


/*
function mDecode(st) {
  return st;
  return (new Buffer(String(st).split('').map(function(x) {
    return x.charCodeAt(0);
  }))).toString('utf-8');
}

function mEncode(st) {
  return st;
  var x = (new Buffer(String(st)));
  return [].map.call(x, function (z) {
    return String.fromCharCode(z);
  }).join('');
}
*/


function mysqlEscape(st) {//needs test
  //return String(st); //!
  //backslashes  for  following characters: \x00, \n, \r, \, ', " and \x1a. 
  return String(st).replace(/[\x00\n\r\\'"\x1a]/g, '\\$&');
}

var Database = require("./websql.js").Database;

function dbConnect() {
  return new Database(dbConfig);
}

function saveToDb(msg, callback) {
  var db = dbConnect(),
    sql;
  sql = 'CREATE TABLE IF NOT EXISTS nodejsChat (' +
        'id       INT AUTO_INCREMENT PRIMARY KEY,';
  sql += Object.keys(msg).map(function (field) {
    return '`' + field + '` TEXT';
  }).join(', ');
  sql += ') DEFAULT CHARSET=utf8';
  db.transaction(function (t) {
    t.executeSql(sql);

    sql = 'INSERT INTO nodejsChat SET ' + Object.keys(msg).map(function (field) {
      return '`' + field + '` = "' + mysqlEscape(msg[field]) + '"';
    }).join(', ');

    //sys.puts(sys.inspect(sql));//!  
    t.executeSql(sql);
  }, function () {
    exit();//?
  }, function () {
    setTimeout(callback, 1);//?
    db.close();
  });
}

function addMessage(from, text, avatar, userId) {
  var msg = {
    from: from,
    text: text,
    avatar: avatar,
    userId: userId,
    timeStamp: +(new Date())
  };
  saveToDb(msg, function () {
    emitter.emit('chatMessage', '');
  });
}

//! требуется отсылать нечто, иначе polyfill EventSource закроет соединение
setInterval(function () {
  emitter.emit('chat15', '');
}, 15000);

var countSSE = 0;


function constructSSE(res, id, data, pcSignalId) {
  id = id + '~' + pcSignalId;
  res.write('id: ' + id + '\n' + 'data: ' + JSON.stringify(data) + '\n\n');
}



//!
function getUser(query, callback) {
  query = query || {};
  var secondpass = query.secondpass || '',
    kuid = query.kuid || '',
    db = dbConnect(),
    to = +query.to || 0,//to тут лишнее! нужно было быстренько сделать ...
    qr = "SELECT uname, user_avatar AS avatar, uid FROM kpro_user LEFT JOIN kpro_usergroup USING (ugroup) WHERE (uid = '" + mysqlEscape(kuid) + "' AND secondpass = MD5('" + mysqlEscape((secondpass)) + "')) OR uid = '" + mysqlEscape(to) + "' LIMIT 2",
    results = {};
  db.transaction(function (tx) {
    tx.executeSql(qr, null, function (tx, result) {
      var i = -1;
      while (++i < result.rows.length) {
        var x = result.rows[i];
        results[x.uid] = x;
      }
    });
  }, function () {
    exit();//?
  }, function () {
    db.close();//TODO: remove
    callback(results[kuid] || null, results[to] || null);
  });
}

function userConnected(user, query) {
  var info = {};
  try {
    info = query ? JSON.parse(query.info) : {};
  } catch (e) {}
  //! но пользователь уже мог с другого браузера зайти!?
  user.peerConnection = !!info.peerConnection;
  user.userAgent = String(info.userAgent).slice(0, 128); // limit - 128 chars

  var u = userConnected.online[user.uid];
  if (!u) {
    userConnected.online[user.uid] = {user: user, count: 1}; // count - кол-во соединений
    emitter.emit('user', 'userConnected', user);
  } else {
    u.count += 1;
    u.user = user;//?
    emitter.emit('user', 'userInfoChanged', user);
  }

  if (userConnected.timers.hasOwnProperty(user.uid)) {
    clearTimeout(userConnected.timers[user.uid]);
    delete userConnected.timers[user.uid];
  }
}

function userDisconnected(user, query) {
  if (userConnected.timers.hasOwnProperty(user.uid)) {
    clearTimeout(userConnected.timers[user.uid]);
    delete userConnected.timers[user.uid];
  }
  if (userConnected.online[user.uid]) {
    userConnected.online[user.uid].count -= 1;
    if (userConnected.online[user.uid].count < 1) {
      //!!! даем 5 секунд на переподключение
      userConnected.timers[user.uid] = setTimeout(function () {
        delete userConnected.online[user.uid];
        emitter.emit('user', 'userDisconnected', user);
      }, 5000);
    }
  }//else не должно быть!?
}

userConnected.online = {};
userConnected.timers = {}; // таймеры по очистке
//!

var pcSignals = [];
var pcSignalsIdCounter = Date.now();// :-)
setInterval(function () {
  //! чушь!
  var k = 0;
  while (k < pcSignals.length && pcSignals[k].timeStamp < Date.now() - 10 * 60 * 1000) {
    k += 1;
  }
  if (k) {
    pcSignals.splice(0, k);
  }
}, 5000);


var calls = {};
var callIdsCounter = Date.now();//!

function Call(toUid, fromPageId, fromUid) {
  callIdsCounter += 1;
  var that = {
    callId: callIdsCounter,
    to: {
      uid: toUid, 
      pageId: null
    }, 
    from: { // инициатор звонка
      uid: fromUid, 
      pageId: fromPageId
    },
    active: function () {
      return this.to.pageId !== null;
    },
    bind: function (user, pageId) {
      if (String(this.to.uid) !== String(user.uid) || this.active()) {
        return false;
      }
      this.to.pageId = pageId;
      return true;
      //emitter.emit('call')
    },
    cancel: function (user) {
      sys.puts('cancel1');
      if (String(user.uid) !== String(this.to.uid) && String(user.uid) !== String(this.from.uid)) {
      
        return null;
      }
      sys.puts('cancel2');
      var that = this;
      pcSignals = pcSignals.filter(function (x) {
        return x.callId !== that.callId;
      });
      delete calls[this.callId];
      sys.puts('cancel3');
      emitter.emit('callCancel', this.callId);//! никто не слушает
    },
    addSignal: function (user, message) {
     sys.puts('add signal '  + typeof (user.uid) );
      var who = String(user.uid) === String(this.to.uid) ? 'to' : (String(user.uid) === String(this.from.uid) ? 'from' : null),
        x;
      if (!who) {
        return null;
      }

      var that = this;
      pcSignalsIdCounter += 1;
      x = {
        callId: this.callId,
        message: message,
        from: user.uid,//? from здесь не тоже самое!, т.к. этот from указывает на того, кто отправил!
        to: this[who === 'to' ? 'from' : 'to'].uid,//?а to здесь указывает на кому!
        pageToId: function () {
          // метод, т.к. после того, как звонок связывается, сигналы тоже связываются
          return that[who === 'to' ? 'from' : 'to'].pageId; // будет null, если не связано ещё!
        },
        timeStamp: Date.now(),
        id: pcSignalsIdCounter
      };
      sys.puts('signal' + sys.inspect(x));
      pcSignals.push(x);

      x.fromUser = {uname: user.uname, uid: user.uid, avatar: user.avatar}; //!убрать x.from, поставить x.fromUser ?
      emitter.emit('pcSignal', x);
    }
  };
  calls[that.callId] = that;//!
  return that;
}


function requestListener(req, res) {

  var url = req.url,
    //cookies = {}, 
    db,
    qr,
    q,
    message,
    post = '',
    socketClosed = false;

  res.socket.on('close', function () {
    socketClosed = true;
  });

    /*
  (req.headers.cookie || '').split(';').forEach(function (cookie) {
    var parts = cookie.split('=');//decodeURIComponent
    cookies[parts[0].trim()] = (parts[1] || '').trim();
  });
  */

  sys.puts(sys.inspect(url));

  q = require('url').parse(url, true);
  if (q.query && Object.prototype.hasOwnProperty.call(q.query, 'message')) { //

    // защита от CSRF
    /* на поддомене нет кукисов ! :(
    if (q.query.secondpass !== cookies.secondpass) {//
      res.writeHead(200, {'Content-Type': 'text/javascript'});
      res.end('failure0' + cookies.secondpass);// no empty!
      return;
    }
    */

    message = q.query.message;//.trim();
    //if (message) {// если не пустое

    getUser(q.query, function (user) {
      if (user) {
        addMessage(user.uname || '?', message || '', user.avatar || '', user.uid || '');
        res.writeHead(200, {
          'Content-Type': 'text/javascript',
          'Access-Control-Allow-Origin': '*'
        });
        res.end('success');
      } else {
        res.writeHead(200, {
              'Content-Type': 'text/javascript',
              'Access-Control-Allow-Origin': '*'
        });
        res.end('failure'); // только для зарегистрированный пользователей !
      }
    });

    return;
  }

  function sendC() {
    res.write(':\n');//?
  }

  function eventStream(user) {
    if (socketClosed) {
      return;//?
    }

    var gLid = post['Last-Event-ID'] || '',
      tmp,
      lid,
      polling,
      lastEventId,
      closed,
      pcSignalId;

    //var tmp = req.url.match(/^\/events(\/(\d+))?$/),
    tmp = req.url.match(/^\/events(\/(\d+))?/);

    lid = +tmp[2] || '';

    if (user) {
      userConnected(user, q.query);//!
    }

    //addMessage('server', req.connection.remoteAddress + ' присоединился');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    });

    if ((req.headers.accept || '').indexOf('text/event-stream') === -1) {
      // 2 kb comment message for XDomainRequest (IE8, IE9)
      res.write(':' + Array(129).join('0123456789ABCDEF') + '\n');
    } else {
      res.write('\n\n'); // we should send something (for Opera - "\n\n")
    }    

    polling = !!req.headers.polling;


    if (!polling) {
      countSSE += 1;
      emitter.emit('countSSE', countSSE);
    }

    function sendSSE2(eventType, data) {
      if (!polling) { //?
        res.write('event: ' + eventType + '\n' + 'data: ' + JSON.stringify(data) + '\n\n');
      }
    }

    //?
    if (!polling) {
      Object.keys(userConnected.online).forEach(function (uid) {
        sendSSE2('userConnected', userConnected.online[uid].user);
        //! отсылаются после каждого переподключения! - не есть хорошо...
      });
    }

    // сначала из header, потом из запроса.... - 
    // тогда при пересоздании объекта EventSource с указанном в url lastEventId 
    // не потеряем lastEventId !?
    lastEventId = req.headers['last-event-id'] || gLid || lid;
    closed = false;

     // lastEventId = lastEventId + '~' + pcSignalId
    lastEventId = String(lastEventId).split('~');

    pcSignalId = +lastEventId[1] || 0;
    lastEventId = +lastEventId[0] || 0;

    sys.puts('lastEventId: ' + sys.inspect(lastEventId));
    //constructSSE(res, null, lastEventId);

    function sendSSE() {
      if (!polling) { //!
        res.write('event: users\n' + 'data: ' + countSSE + '\n\n');
      }
    }

    function sendNotification(data) {
      if (!data.to || (user && String(data.to) === String(user.uid))) {
        res.write('event: notification\n' + 'data: ' + JSON.stringify(data) + '\n\n');
      }
    }

    function end() {
      emitter.removeListener('countSSE', sendSSE);

      emitter.removeListener('notification', sendNotification);
      
      emitter.removeListener('chat15', sendC);
      emitter.removeListener('chatMessage', sendMessages);
      emitter.removeListener('user', sendSSE2);
      emitter.removeListener('pcSignal', sendPCSignalMessage);
      emitter.removeListener('callCancel', sendCallCancel);

      if (user) {
        userDisconnected(user, q.query);//?
      }
      //res.end();
      if (!closed) {
        closed = true;
        res.end();

        if (!polling) {
          countSSE -= 1;
          emitter.emit('countSSE', countSSE);
        }
      }
    }


    var userId = user ? user.uid : null;

    function sendSignals() {
      // отправляем!
      var i;
      for (i = 0; i < pcSignals.length; i += 1) {
        if (pcSignals[i].id > pcSignalId) {
          sendPCSignalMessage(pcSignals[i]);
        }
      }
      //+ текущее состояние активные+неактивные
      var data = [];
      for (i in calls) {
        data.push({
          callId: i,
          active: calls[i].active()//а зачем???
        });
      }
      res.write('event: callStates\ndata: ' + JSON.stringify(data) + '\n\n');
    }

    sendSignals();

    function sendCallCancel(callId) {
      //без фильтрации пока что!
      sys.puts('sendCallCancel: ' + callId);
      res.write('event: callCancel\ndata: ' + callId + '\n\n');
    }

    function sendPCSignalMessage(data) {
      if ( (data.pageToId() === null || q.query.pageId === data.pageToId()) && // если еще не связано, либо pageid === pageToId
          String(data.to) === String(userId) &&
          String(data.from) !== String(userId)) { // сам себе? => сам виноват!?
      // ну с userId совсем плохо сделано!!!
        res.write('id: ' + (lastEventId + '~' + data.id) + '\nevent: pcSignal\ndata: ' + JSON.stringify(data) + '\n\n');
        pcSignalId = data.id;
      }
    }

    function sendMessages() {
   
      var someSended = false;    
      /*
      lastEventId = lastEventId || (SELECT id ORDER BY id LIMIT 1)  - последний
      SELECT * FROM nodejsChat WHERE id > lastEventId
      */
      db = dbConnect();
      qr = "SELECT * FROM nodejsChat WHERE id > " + lastEventId + " ORDER BY id";//отправляется вся история!
      if (!lastEventId) {//!
        qr += " DESC LIMIT 1";//отдаем только одно сообщение первый раз...
      }
      
      db.transaction(function (tx) {
        tx.executeSql(qr, null, function (tx, result) {
          result.rows.forEach(function (msg) {
            constructSSE(res, +msg.id, msg, pcSignalId);
            someSended  = true;
            lastEventId = +msg.id;
          });
        });
      }, function () {
       exit();//?
      }, function () {
        db.close();
        if (someSended && polling) {//longpolling
          end();
        }
      });

    }
    sendMessages();

    if (!closed) { // иначе будет ошибка - сокет уже закрыт
    
      emitter.addListener('countSSE', sendSSE);
      sendSSE();//! уже изменили, событие не поймали
      
      emitter.addListener('notification', sendNotification);
    
      emitter.addListener('chat15', sendC);
      emitter.addListener('chatMessage', sendMessages);
      emitter.addListener('user', sendSSE2);
      emitter.addListener('pcSignal', sendPCSignalMessage);/*!!! не сделано, чтобы при переподключених передавались все пропущенные сообщения!!!!! */
      emitter.addListener('callCancel', sendCallCancel);
      
      emitter.setMaxListeners(0);//?
    }

    //setTimeout(end, 60000);//? -> res.socket.on('close', ...)

    //var ip = req.connection.remoteAddress;

    if (!closed) {   
      res.socket.on('close', function () {
        //addMessage('server', ip + ' onclose', '', '');//!
        end();       
      });      
    }
  }
  
  if (req.url.split('?')[0] === '/callNew') {
    getUser(q.query, function (user, userTo) {
      if (user) {
        if (String(q.query.to) === String(user.uid)) {
          //запрет звонков самому себе
          res.writeHead(400, {
            'Content-Type': 'text/html',
            'Access-Control-Allow-Origin': '*'
          });
          res.write('self');
          res.end();
          return;
        }

        var c = new Call(q.query.to, q.query.pageId, user.uid);
        res.writeHead(200, {
          'Content-Type': 'text/json',
          'Access-Control-Allow-Origin': '*'
        });
        //String(c.callId)
        res.write(JSON.stringify({
          callId: c.callId,
          to: (userTo ? { //даже отбой звонка не реализован, если юзер левый
            avatar: userTo.avatar,
            uname: userTo.uname
          } : null)
        }));
        res.end();
      } else {
        res.writeHead(403, {
          'Content-Type': 'text/html',
          'Access-Control-Allow-Origin': '*'
        });
        res.write('?');
        res.end();
      }
    });
    return;
  }

  if (req.url.split('?')[0] === '/callCancel') {
    getUser(q.query, function (user) {
      if (user) {
        var c = calls[q.query.callId];
        if (c) {
          c.cancel(user);//! нет проверки pageId, как всегда!?!- нужно ли добавить!?
        }
        res.writeHead(200, {
          'Content-Type': 'text/html',
          'Access-Control-Allow-Origin': '*'
        });
        res.write('ok');
        res.end();
      } else {
        res.writeHead(403, {
          'Content-Type': 'text/html',
          'Access-Control-Allow-Origin': '*'
        });
        res.write('?');
        res.end();
      }
    });
    return;
  }

  if (req.url.split('?')[0] === '/pcSignal') {
    post = '';
    var onRequestEnd = function () {
      getUser(q.query, function (user) {
        if (user) {
          var c = calls[q.query.callId];
          
          if (c && c.active() && String(c.to.uid) === String(user.uid) && c.to.pageId !== q.query.pageId) {
            /*
              запускаем от одного пользователя две вкладки
              звоним от другого пользователя этому
              в одной из вкладкого user1 принимаем звонок
              смотри в другую вкладку - 1) там всё еще висит предложение
              2) его можно принять, потому что этой проверки не было
            */
            res.writeHead(200, {
              'Content-Type': 'text/html',
              'Access-Control-Allow-Origin': '*'
            });
            res.write('error: соединение уже установлено');//!
            res.end();
            return;
          }

          if (c) {
            sys.puts('xy1: ' + c.active() + ' ' + c.from.uid + ' ' + user.uid);
            if (!c.active() && String(c.from.uid) !== String(user.uid)) {
              if (!c.bind(user, q.query.pageId)) {
                res.writeHead(200, {
                  'Content-Type': 'text/html',
                  'Access-Control-Allow-Origin': '*'
                });
                res.write('error: уже активный callId !?');//!
                res.end();
                return null;//?
              }
            }

            c.addSignal(user, post);
          }

          res.writeHead(200, {'Content-Type': 'text/html',
          'Access-Control-Allow-Origin': '*'});
          res.write('ok');
          res.end();
        } else {
          res.writeHead(403, {'Content-Type': 'text/html',
          'Access-Control-Allow-Origin': '*'});
          res.write('?');
          res.end();
        }
      });
    }
    req.addListener('data', function (data) {
      post += data;
      if (post.length > 32000) {
        req.removeListener('end', onRequestEnd);
        res.writeHead(414, {});
        res.end();//!
      }
    });
    req.addListener('end', onRequestEnd);
    return;
  }
  
  if (req.url.split('?')[0] === '/notification') {
    //! нет проверки на жуликов!
    var notification = null;
    try {
      notification = JSON.parse(q.query.notification);
    } catch (e) {}
    if (notification && notification.message && notification.title) {// notification.to = uid ?
      //!
      emitter.emit('notification', notification);
    }
    res.writeHead(200, {
      'Content-Type': 'text/html',
    });
    res.write('1');
    res.end();
    return;
  }

  //if (/^\/events(\/(\d+))?$/.test(req.url)) {
  if (/^\/events(\/(\d+))?\/?(\?[\s\S]+)?$/.test(req.url)) {
    var onRequestEnd2 = function () {
      post = querystring.parse(post);
      getUser(q.query, eventStream);
	};
    post = '';
    req.addListener('data', function (data) {
      post += data;
      if (post.length > 32000) {
        req.removeListener('end', onRequestEnd2);
        res.writeHead(414, {});
        res.end();//!
      }
	});
    req.addListener('end', onRequestEnd2);

  } else {
    //
    var m = req.url.split('?')[0].match(/^\/history\/(\d+)\/?$/),
      upper;
    if (m && m[0]) {
      upper = +m[1];
      res.writeHead(200, {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*' //! PUBLIC !
      });//?
//              'Access-Control-Allow-Origin' : '*'

      // отправляем ответом JSON - до 10 сообщений пользователю с id < upper
      db = dbConnect();
      qr = "SELECT * FROM nodejsChat WHERE id < " + upper + " ORDER BY id DESC LIMIT 16";

      db.transaction(function (tx) {
        tx.executeSql(qr, null, function (tx, result) {
          toSend = result.rows;
        });
      }, function () {
      
      }, function () {
        res.write(JSON.stringify(toSend));
        res.end();
        db.close();
      });

      return;//!
    }

    res.end();
  }
}

/*
if (true) {
  https.createServer({
    key: fs.readFileSync('/usr/local/etc/nginx/ssl/hostel6.key'),
    cert: fs.readFileSync('/usr/local/etc/nginx/ssl/hostel6.crt')
  }, requestListener).listen(8011);
}*/

http.createServer(requestListener).listen(8001);
