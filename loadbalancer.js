var prod = true;
if(process.argv.length==3 && process.argv[2]=="-d")
        prod = false;

var crypto = require('crypto');
var express = require('express');
var http = require('http');
var https = require('https');
var xml = require('node-xml');
var syslog = require('node-syslog');
//var cluster = require('cluster');
var fs = require('fs');
//for connecting to relay perfmonitor
var net = require('net');
var couchdb = require('felix-couchdb');
var client = couchdb.createClient(5984, 'localhost');
var db = client.db('relay_servers');
var reqPerGame = {};
var failedServers = new Array();
syslog.init("load-balancer", syslog.LOG_PID | syslog.LOG_ODELAY, syslog.LOG_USER);
syslog.log(syslog.LOG_INFO, 'Starting load balancer.');

if(prod)
{
	privateKey = fs.readFileSync(__dirname+'/ssl/server.key').toString();
	certificate = fs.readFileSync(__dirname+'/ssl/server.crt').toString();
	ca = fs.readFileSync(__dirname+'/ssl/ca.crt').toString();
	syslog.log(syslog.LOG_INFO, 'Production environment, requiring certificate.');
}

var lb = express.createServer();

//var testServer = express.createServer();
var perfPort = express.createServer();
perfPort.use(express.bodyParser());
lb.use(express.bodyParser());
//testServer.use(express.bodyParser());
var serverData = new Array();

var probabilityMax;
/*
testServer.get('/', function(req,res){
	res.contentType("text/xml");
	res.sendfile('test.xml');
});
*/
lb.get('/', function(req, res){
	var failIp = req.param('fail', '');
	if(failIp != '')
	{
		syslog.log(syslog.LOG_WARNING, 'Client reported relay server at ' + failIp + ' failed.');
		if(serverData[failIp])
		{
			if(serverData[failIp] != null)
			{
				serverData[failIp].probability -= 1;
				if(serverData[failIp].probability <= 0)
				{
					syslog.log(syslog.LOG_ERR, 'Too many fails. Sending an error for: ' + failIp);
					if(failedServers.indexOf(failIp) == -1)
						failedServers.push(failIp);
				}
			}
		}
	}
	var serv = getServer();
	var i = 0;
	//check to see if serv is not null, is not in the failed server list and was not reported as just failed
	while(serv && (failedServers.indexOf(serv.ip + ':' + serv.port) != -1 || serv.ip + ':' + serv.port == failIp))
	{
		serv = getServer();
		i++;
		//magic number!
		if(i >= 10)
		{
			serv = null;
			break;
		}
	}
	if(serv != null)
	{
		var gameId = req.param('gameId', '');
		if(gameId != '')
		{
			if(reqPerGame[gameId] == undefined)
			{
				reqPerGame[gameId] = 0;
			}
			reqPerGame[gameId]++;
		}
		res.send({ip: serv.ip, port: serv.port});
	}
	else
	{
		syslog.log(syslog.LOG_ERR, 'No servers were found!');
		res.send({error: 'All the servers broke.'});
	}
});

function getServer()
{
	//no servers to connect to
	if(probabilityMax == 0)
		return null;
	var random = Math.random() * probabilityMax;
	var current = 0;
	var i;
	for(i in serverData)
	{
		var server = serverData[i];
		if(current + server.probability >= random)
		{
			return server;
		}
		current += server.probability;
	}
	return null;
}

lb.post('/add', function(req, res){
	//TODO: get the actual IP and parse it
	var ip = req.body.ip;
	var port = req.body.port;
	if(serverData[ip + ':' + port] != undefined)
		return;
	syslog.log(syslog.LOG_INFO, 'Added relay server ' + ip + ':' + port);
	addIP(ip, port);
	res.send('ok');
});

function addIP(ip, port)
{
	var options = {
		host: 'localhost',
		port: 5984,
		path: '/relay_servers/',
		method: 'POST',
		headers: {'Content-Type': 'application/json'}
	};
	var post = http.request(options, function(response){
		var data = '';
		response.on('data', function(chunk){
			data += chunk;
		});
		response.on('end', function(){
			console.log(data);
		});
	});
	post.on('error', function(error) {
		syslog.log(syslog.LOG_ERR, 'Failed to connect to couchdb to add server!');
	});
	post.write(JSON.stringify({ip:ip, port:port}));
	post.end();
}

lb.post('/remove', function(req, res){
	var ip = req.body.ip;
	console.log('remove: ' + ip);
	removeIP(ip);
	syslog.log(syslog.LOG_INFO, 'Removed relay server ' + ip);
	res.send('ok');
});

function removeIP(ip)
{
	if(!serverData[ip])
		return;

	var options = {
		host: 'localhost',
		port: 5984,
		path: '/relay_servers/' + serverData[ip]._id + '?rev=' + serverData[ip]._rev,
		method: 'DELETE',
		headers: {'Content-Type': 'application/json'}
	};
	var del = http.request(options, function(response){
		var data = '';
		response.on('data', function(chunk){
			data += chunk;
		});
		response.on('end', function(){
			console.log(data);
		});
	});
	del.on('error', function(error) {
		syslog.log(syslog.LOG_ERR, 'Failed to connect to couch db for server removal!');
	});
	//del.write(JSON.stringify({ip:ip, port:serverData[server].port}));
	del.end();

	if(serverData[ip])
	{
		delete serverData[ip];
	}
}

//poll all servers every ? seconds
setInterval(function(){
	
		client.request('/relay_servers/_design/servers/_view/all', function(er, data){
			if(data == undefined)
			{
				return;
			}
			//console.log(data);
			var rows = data.rows;
			
			var couchData = {};

			for(i in rows)
			{
				var value = rows[i].value;
				//value.ip, port
				//if there is a server not in memory
				if(!serverData[value.ip + ':' + value.port])
				{
					serverData[value.ip + ':' + value.port] = value;
				}
				couchData[rows[i].key]=value;
			}
			//if there is a server not in couch but in memory
			for(server in serverData)
			{
				if(!couchData[server])
					delete serverData[server];
			}
			for(server in serverData)
			{
				var socket = net.createConnection(40910, serverData[server].ip);
				var data = '';
				console.log('opened socket on 40910 with server ' + serverData[server].ip);
				socket.on('data', function(chunk){
					data += chunk;
				}).on('end', function(){
					//server not quite ready yet
					if(data == undefined)
					{
						return;
					}
					//server back online, remove from failed server list
					if(failedServers.indexOf(server) != -1)
					{
						failedServers.splice(failedServers.indexOf(server), 1);
					}

					//console.log("Server Data:\n" + data);
					var currentElem = '';
					var recorded = false;
					var parser = new xml.SaxParser(function(cb) {
						cb.onStartElementNS(function(elem, attrs, prefix, uri, namespaces) {
							currentElem = elem;
							recorded = false;
						});
						cb.onCharacters(function(chars) {
							
							if(recorded == false){
								serverData[server][currentElem] = chars;
								recorded = true;
							}
						});
					});
	
					//console.log(data);
					parser.parseString(data);
				});
				socket.on('error', function(error) {
					//have to get perf monitor to parse this
					serverData[server].status = 'FAIL';
					//since the server failed, do not allocate anything to it
					serverData[server].maxconns = 0;
					serverData[server].totalconns = 0;
					serverData[server].probability = 0;
					if(failedServers.indexOf(server) == -1)
					{
						failedServers.push(server);
					}
					syslog.log(syslog.LOG_ERR, 'Unable to connect to server ' + serverData[server].ip + serverData[server].port);
				});
				socket.end();
			}
			//pause a little to make sure the parser is done
			setTimeout(function(){
				//don't update probabilityMax until it's done computing
				var tempProbMax = 0;
				//calculate percentages
				for(var i in serverData)
				{
					var server = serverData[i];
					tempProbMax += server.maxconns - server.totalconns;
					server.probability = server.maxconns - server.totalconns;
					server.lastupdate = server.timestamp;
				}
				probabilityMax = tempProbMax;
			},
			200);
		});
	
},
//number of milliseconds
5000);

//60 second timer to send stats to stats collector
setInterval(function()
{
	var stats = {};
	stats.totalconns = 0;
	stats.msgpersec = 0;
	stats.remainconns = 0;
	stats.bytessentpersec = 0;
	for(ip in serverData)
	{
		stats.remainconns += parseFloat(serverData[ip].probability);
		stats.totalconns += parseFloat(serverData[ip].totalconns);
		stats.msgpersec += parseFloat(serverData[ip].msgsentpersec);
		stats.bytessentpersec += parseFloat(serverData[ip].bytessentpersec);
	}
	console.log(JSON.stringify(stats));	
	var options = {
//		host: 'metrics.gamespy.net',
		host: 'gstapi-stgutil-01.sfdev.colo.ignops.com',
		port: 80,
		path: '/analytics/5823/relay_stats',
		method: 'POST',
		headers: {'Content-Type': 'application/json'}
	};
	var post = http.request(options, function(response){
		console.log('response from stats');
		var data = '';
		response.on('data', function(chunk){
			data += chunk;
		});
		response.on('end', function(){
			console.log('end response from stats');
			console.log(data);
		});
	});
	post.on('error', function(error) {
		syslog.log(syslog.LOG_ERR, 'Could not connect to metrics.gamespy.net');
	});
	post.write(JSON.stringify(stats));
	post.end();
	for (id in reqPerGame)
	{
		options.path = '/analytics/' + id + '/relay_reqs';

		post = http.request(options, function(response){
			var data = '';
			response.on('data', function(chunk){
				data += chunk;
			});
			response.on('end', function(){
				console.log(data);
			});
		});
		post.on('error', function(error) {
			syslog.log(syslog.LOG_ERR, 'Could not connect to metrics.gamespy.net');
		});
		post.write(JSON.stringify({relay_requests: reqPerGame[id]}));
		post.end();
		reqPerGame[id] = 0;
	}

},
60000);
//number of milliseconds

perfPort.get('/', function(req,res){
	//construct XML
	var xml = '<perfdata appname="ProxyServerLoadBalancer" machinename="PSLB01">';
	xml += '<status>OK</status>';
	xml += '<failedservercount counter="Failed Server Count">';
	xml += failedServers.length;
	xml += '</failedservercount>';
	if(failedServers.length > 0)
	{
		xml += '<failedservers>';
		xml += failedServers.toString();
		xml += '</failedservers>';
	}
	var serverCount = 0;
	for(ip in serverData)
	{
		serverCount++;
		//happens if the server has been added but not polled yet
		if(serverData[ip].hostcount == undefined)
			continue;
		xml += '<data ip="' + ip + '">';
		xml += '<status>' + serverData[ip].status + '</status>';
		xml += '<health>' + serverData[ip].probability + '</health>';
		xml += '<hostcount counter="Host Count">' + serverData[ip].hostcount;
		xml += '</hostcount>';
		xml += '<clientcount counter="Client Count">' + serverData[ip].clientcount;
		xml += '</clientcount>';
		xml += '<cpu counter="CPU Utilization">' + serverData[ip].cpu;
		xml += '</cpu>';
		xml += '<normcpu counter="Normalized CPU Utilization">' + serverData[ip].normcpu;
		xml += '</normcpu>';
		xml += '<mem counter="Heap Usage in MB">' + serverData[ip].mem;
		xml += '</mem>';
		xml += '<maxconns counter="Max Connection Count">';
		xml += serverData[ip].maxconns;
		xml += '</maxconns>';
		xml += '<maxports counter="Max Port Count">' + serverData[ip].maxports;
		xml += '</maxports>';
		xml += '<totalconns counter="Connection Count">';
		xml += serverData[ip].totalconns;
		xml += '</totalconns>';
		xml += '<msgrecvcount counter="Messages Recv Counter">';
		xml += serverData[ip].msgrecvcount;
		xml += '</msgrecvcount>';
		xml += '<msgsentcount counter="Messages Sent Counter">';
		xml += serverData[ip].msgsentcount;
		xml += '</msgsentcount>';
		xml += '<msgrecvpersec counter="Messages Recv Per Second">';
		xml += serverData[ip].msgrecvpersec;
		xml += '</msgrecvpersec>';
		xml += '<msgsentpersec counter="Messages Sent Per Second">';
		xml += serverData[ip].msgsentpersec;
		xml += '</msgsentpersec>';
		xml += '<bytessentpersec counter="Bytes Sent Per Second">';
		xml += serverData[ip].bytessentpersec;
		xml += '</bytessentpersec>';
		xml += '</data>';
	}
	xml += '<servercount counter="Server Count">';
	xml += serverCount;
	xml += '</servercount>';
	xml += '</perfdata>';
	res.contentType('text/xml');
	res.send(xml);
});


//start clustered service
/*var numCluster = prod ? 4 : 1;
for(var i = 0; i < numCluster; i++)
{
	if(cluster.isMaster && i == 0)
	{
	*/
		client.request({
			method: 'PUT',
			path: '/relay_servers'
		}, function(data){
			console.log('creating relay server db.');
		});

		setTimeout(function(){
			client.request({
				path: '/relay_servers/_design/servers',
				method: 'PUT',
				data: {
					language: 'javascript',
					views: {
						all:{
							map: "function(doc) { emit(doc.ip + ':' + doc.port, doc) }"
						}
					}	
				}
			}, function(data){
				console.log('creating relay server view.');
			});
		}, 1000);
/*
	} if(cluster.isMaster && prod){
		cluster.fork();
		cluster.on('death', function(worker){
			syslog.log(syslog.LOG_INFO, 'Worker thread died, restarting.');
			cluster.fork();
		});
	}
	else
	{
	*/
		if(prod)
		{
			https.createServer({key:privateKey, 
				cert:certificate,
				ca:ca,
				requestCert: true,
				rejectUnauthorized: true
			},lb).listen(443);
		}else{
			lb.listen(3000);
		}
/*
	}
}
*/
//testServer.listen(4910);
perfPort.listen(10000);
syslog.log(syslog.LOG_INFO, 'Load balancer is now running.');
