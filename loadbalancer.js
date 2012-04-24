var prod = true;
if(process.argv.length==3 && process.argv[2]=="-d")
        prod = false;

var express = require('express');
var http = require('http');
var xml = require('node-xml');
var fs = require('fs');

if(prod){
	privateKey = fs.readFileSync(__dirname+'/ssl/server.key').toString();
	certificate = fs.readFileSync(__dirname+'/ssl/server.crt').toString();
}

var lb;
if(prod)
	lb = express.createServer({key:privateKey, cert:certificate});
else
	lb = express.createServer();

var testServer = express.createServer();
var perfPort = express.createServer();
perfPort.use(express.bodyParser());
lb.use(express.bodyParser());
testServer.use(express.bodyParser());
var servers = new Array();
var serverPorts = new Array();
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
		var index = servers.indexOf(failIp);
		if(index >= 0)
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
	var ip = getServer();
	if(ip == failIp && servers.length == 1)
	{
		res.send({error: 'Our only IP failed.'});
		return;
	}
	while(ip == failIp)
	{
		ip = getServer();
	}
	if(ip != null)
	{
		res.send({ip: ip, port: serverPorts[ip]});
	}
	else
	{
		res.send({error: 'Something bad happened.'});
	}
});

function getServer()
{
	var random = Math.random() * probabilityMax;
	var current = 0;
	var i;
	for(i in servers)
	{
		var server = serverData[servers[i]];
		if(current + server.probability >= random)
		{
			return servers[i];
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
	servers.push(ip);
	serverPorts[ip] = port;
	var serverJson = {};
	//write to file
	for(var i in serverPorts)
	{
		
	}
	serverData[ip] = new Object();
	res.send('ok');
});
lb.post('/remove', function(req, res){
	//TODO: get the actual IP and parse it
	var ip = req.body.ip;
	console.log('remove: ' + ip);
	removeIP(ip);
	res.send('ok');
});

function removeIP(ip)
{
	if(servers.indexOf(ip) != -1)
	{
		servers.splice(servers.indexOf(ip), 1);
		serverData[ip] = null;
		serverPorts[ip] = null;
	}
}

//poll all servers every ? seconds
setInterval(function(){
	
	for(i in servers)
	{
		var server = servers[i];
		var options = {
			host: server,
			port: serverPorts[server],
			path: '/'
		};
		var get = http.request(options, function(response){
			//TODO: get the actual data and parse it
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
			console.log('unable to connect to server: ' + error);
		});
		get.end();
	}
	//pause a little to make sure the parser is done
	setTimeout(function(){
		//don't update probabilityMax until it's done computing
		var tempProbMax = 0;
		//calculate percentages
		for(var i in servers)
		{
			var server = serverData[servers[i]];
			var server = serverData[servers[i]];
			tempProbMax += server.maxconns - server.totalconns;
			server.probability = server.maxconns - server.totalconns;
			server.lastupdate = server.timestamp;
		}
		probabilityMax = tempProbMax;
	},
	200);
	
},
//number of seconds
5000);

perfPort.get('/', function(req,res){
	//construct XML
	var xml = '<perfdata appname="ProxyServerLoadBalancer" machinename="PSLB01">';
	xml += '<status>OK</status>';
	var i;
	for(i in servers)
	{
		var ip = servers[i];
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

lb.listen(3000);
testServer.listen(3001);
perfPort.listen(10000);
