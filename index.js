const mosca = require('mosca'),
fs = require('fs'),
{promisify} = require('util')
redis = require('redis'),
Jimp = require('jimp'),
request = require('request-promise'),
labels = JSON.parse(fs.readFileSync("imagenet_class_index.json")),
redisClient = redis.createClient(),
sendCommand = promisify(redisClient.sendCommand).bind(redisClient);


const graph_filename = 'mobilenet_v2_1.4_224_frozen.pb',
image_height = 224;
image_width = 224;
input_var = 'input';
output_var = 'MobilenetV2/Predictions/Reshape_1';


const ascoltatore = {
		type: 'redis',
		redis: redis,
		db: 12,
		port: 6379,
		return_buffers: true, // to handle binary payloads
		host: "localhost"
},
moscaSettings = {
		port: 1883,
		backend: ascoltatore,
		persistence: {
			factory: mosca.persistence.Redis
		}
};


function normalize_rgb(buffer) {
	let npixels = buffer.length / 4;
	let out = new Float32Array(npixels * 3);
	for (let i=0; i<npixels; i++) {
		out[3*i]   = buffer[4*i]   / 128 - 1;
		out[3*i+1] = buffer[4*i+1] / 128 - 1;
		out[3*i+2] = buffer[4*i+2] / 128 - 1;
	}
	return out;
}

function argmax(arr, start, end) {
	start = start | 0;
	end = end | arr.length;
	let index = 0;
	let value =  parseFloat(arr[index]);
	for (let i=start; i<end; i++) {
		let tmp = parseFloat(arr[i]);
		if (tmp > value) {
			value = tmp;
			index = i;
		}
	}
	return index;
}

//load graph
const buffer = fs.readFileSync(graph_filename, {'flag': 'r'});
console.log("Setting graph");

sendCommand('EXISTS', ['mobilenet'])
.then( (res) => {
	console.log(res)
	if(!res){
		return sendCommand('TF.GRAPH', ['mobilenet', buffer]);
	}
})
.then( () => {
	console.log('then')

	let server = new mosca.Server(moscaSettings);
	server.on('ready', () => console.log('Mosca server is up and running'));
	server.on('clientConnected', client =>	console.log('client connected', client.id));

	//	fired when a message is received
	server.on('published', function(packet, client) {

		if(packet.topic === 'EdgeXDataTopic'){
			let event = JSON.parse(packet.payload.toString('utf8'));
			if(event && event.readings && event.readings[0]){


				let img = event.readings[0].value;
				let blob = Buffer.from(img, 'base64');
				Jimp.read(blob).then(input_image => {
					let image = input_image.cover(image_width, image_height);
					let normalized = normalize_rgb(image.bitmap.data, image.hasAlpha());
					let buffer = Buffer.from(normalized.buffer)

					sendCommand('TF.TENSOR', ['input_' + packet.messageId, 'FLOAT', 4, 1, image_width, image_height, 3, 'BLOB', buffer])
					.then( res => sendCommand('TF.RUN', ['mobilenet', 1, 'input_' + packet.messageId, input_var, 'output_' + packet.messageId, output_var]))
					.then( res => sendCommand('TF.VALUES', ['output_' + packet.messageId]))
					.then( res => {
						label = argmax(res);
						if(label){
							let animal = labels[label-1][1]
							if(label >= 281 && label <=293){
								console.log('CAT!!!! ' + animal);

								var options = {
										method: 'POST',
										uri: 'http://redisedgex.azurewebsites.net/image',
										body: {
											image: 'data:image/jpeg;base64,' + img
										},
										json: true // Automatically stringifies the body to JSON
								};
								return request(options)
								.then(function (res) {
							        console.log(res);
							    });
							} 
							
							console.log('NOT CAT!!!! ' + animal);
						}

					})
					.then( res => sendCommand('del', ['output_' + packet.messageId, 'input_' + packet.messageId]))
					.catch(function (err) {
						console.error(err);
				    })
				})
				.catch(err => {
					console.error(err);
				});
			}
		} else {
			console.log('Published', packet.topic, packet.payload.toString('utf8'));	  
		}
	});
});

