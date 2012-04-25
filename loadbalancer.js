var prod = true;
if(process.argv.length==3 && process.argv[2]=="-d")
        prod = false;

var crypto = require('crypto');
var express = require('express');
var http = require('http');
var https = require('https');
var xml = require('node-xml');
var fs = require('fs');

if(prod)
{
	privateKey = fs.readFileSync(__dirname+'/ssl/server.key').toString();
	certificate = fs.readFileSync(__dirname+'/ssl/server.crt').toString();
	ca = fs.readFileSync(__dirname+'/ssl/certificate.pem').toString();
}

var lb = express();

var testServer = express.createServer();
var perfPort = express.createServer();
perfPort.use(express.bodyParser());
lb.use(express.bodyParser());
testServer.use(express.bodyParser());
var serverData = new Array();

var probabilityMax;

testServer.get('/', function(req,res){
	res.contentType("text/xml");
	res.sendfile('test.xml');
});

lb.get('/', function(req, res){
	var failIp = req.param('fail', '');
	if(failIp != '')
	{
		if(serverData[failIp])
		{
			if(serverData[failIp] != null)
			{
				serverData[failIp].probability -= 1;
				if(serverData[failIp].probability <= 0)
				{
					removeIP(failIp);
				}
			}
		}
	}
	var serv = getServer();
	/*
	if(ip == failIp && serverData.length ==)
	{
		return;
	}
	*/
	var i = 0;
	while(serv && serv.ip + ':' + serv.port == failIp)
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
		res.send({ip: serv.ip, port: serv.port});
	}
	else
	{
		res.send({error: 'All the servers broke.'});
	}
});

function getServer()
{
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
	console.log('add: ' + ip + ':' + port);
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
	});
	post.write(JSON.stringify({ip:ip, port:port}));
	post.end();
}

lb.post('/remove', function(req, res){
	var ip = req.body.ip;
	console.log('remove: ' + ip);
	removeIP(ip);
	res.send('ok');
});

function removeIP(ip)
{
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
	
	var options = {
		host: 'localhost',
		port: 5984,
		path: '/relay_servers/_design/servers/_view/all'
	};
	var get = http.request(options, function(response){
		var data = '';
		response.on('data', function(chunk){
			data += chunk;
		});
		response.on('end', function(){
			console.log(data);
			var rows = JSON.parse(data).rows;
			
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
				var options = {
					host: serverData[server].ip,
					port: serverData[server].port,
					path: '/'
				};
				var get = http.request(options, function(response){
					var data = '';
					response.on('data', function(chunk){
						data += chunk;
					});
					response.on('end', function(){
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
		
						parser.parseString(data);
					});
				});
				get.on('error', function(error) {
					//have to get perf monitor to parse this
					serverData[server].status = 'FAIL';
					console.log('unable to connect to server: ' + error);
				});
				get.end();
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
	});
	get.on('error', function(error) {
		console.log('unable to connect to server: ' + error);
	});
	get.end();
	
},
//number of seconds
5000);

perfPort.get('/', function(req,res){
	//construct XML
	var xml = '<perfdata appname="ProxyServerLoadBalancer" machinename="PSLB01">';
	xml += '<status>OK</status>';
	for(ip in serverData)
	{
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
		xml += '</data>';
	}
	xml += '</perfdata>';
	res.contentType('text/xml');
	res.send(xml);
});

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

testServer.listen(3001);
perfPort.listen(10000);
console.log('running');
