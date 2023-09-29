import { APIGatewayProxyEvent, APIGatewayProxyResult, Context } from 'aws-lambda';
import { Metrics } from '@aws-lambda-powertools/metrics';
import { Logger } from '@aws-lambda-powertools/logger';
import { Tracer } from '@aws-lambda-powertools/tracer';
import { config } from 'dotenv';
import axios from 'axios';
import protobuf from 'protobufjs';

const metrics = new Metrics();
const logger = new Logger();
const tracer = new Tracer();

// Load environment variables from the .env file in the current directory
config();

// Get the API_URL and API_KEY from the environment variables
const apiUrl = process.env.API_URL;
const apiKey = process.env.API_KEY;

if (!apiUrl || !apiKey) {
  console.error('API_URL and API_KEY are required in the .env file.');
  process.exit(1);
}

// Create an Axios instance with the custom headers
const axiosInstance = axios.create({
    headers: {
      'apiKey': apiKey,
    },
  });

/**
 *
 * Event doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html#api-gateway-simple-proxy-for-lambda-input-format
 * @param {APIGatewayProxyEvent} event - API Gateway Lambda Proxy Input Format
 * @param {Context} object - API Gateway Lambda $context variable
 *
 * Return doc: https://docs.aws.amazon.com/apigateway/latest/developerguide/set-up-lambda-proxy-integrations.html
 * @returns {APIGatewayProxyResult} object - API Gateway Lambda Proxy Output Format
 *
 */

export const handler = async (event: APIGatewayProxyEvent, context: Context): Promise<APIGatewayProxyResult> => {
    let response: APIGatewayProxyResult;

    // Log the incoming event
    logger.info('Lambda invocation event', { event });

    // Append awsRequestId to each log statement
    logger.appendKeys({
        awsRequestId: context.awsRequestId,
    });
    // Get facade segment created by AWS Lambda
    const segment = tracer.getSegment();

    if (!segment) {
        response = {
            statusCode: 500,
            body: 'Failed to get segment',
        };
        return response;
    }

    // Create subsegment for the function & set it as active
    const handlerSegment = segment.addNewSubsegment(`## ${process.env._HANDLER}`);
    tracer.setSegment(handlerSegment);

    // Annotate the subsegment with the cold start & serviceName
    tracer.annotateColdStart();
    tracer.addServiceNameAnnotation();

    // Add annotation for the awsRequestId
    tracer.putAnnotation('awsRequestId', context.awsRequestId);
    // Capture cold start metrics
    metrics.captureColdStartMetric();
    // Create another subsegment & set it as active
    const subsegment = handlerSegment.addNewSubsegment('### MySubSegment');
    tracer.setSegment(subsegment);

    try {

        // Fetch data from the STM API
        const stmResponse = await axiosInstance.get(apiUrl);
  
      // Load the Protocol Buffer definition (you may need to adjust the path)
      const root = await protobuf.load('./config/gtfs-realtime.proto');
  
      // Parse the binary response using the Protocol Buffer definition
      const message = root.lookupType('VehiclePosition'); // Replace with the actual message type
      const decodedData = message.decode(new Uint8Array(stmResponse.data));
      console.log(decodedData)
  
      // Convert the decoded data to JSON
      const jsonData = message.toObject(decodedData, {
        enums: String,  // Enum values as strings
        longs: String,  // Long values as strings (requires protobufjs version 6.x)
        bytes: String, // Bytes as base64 encoded strings
      });
  
      response = {
        statusCode: 200,
        headers: {
            'Content-type': 'application/json'
        },
        body: JSON.stringify({
            jsonData
        })
      }

      console.log(jsonData);
    
    } catch (err) {
        // Error handling
        response = {
            statusCode: 500,
            body: JSON.stringify({
                message: 'Error fetching STM data:',
            }),
        };
        tracer.addErrorAsMetadata(err as Error);
        logger.error(`Error response from API enpoint: ${err}`, response.body);
    } finally {
        // Close subsegments (the AWS Lambda one is closed automatically)
        subsegment.close(); // (### MySubSegment)
        handlerSegment.close(); // (## index.handler)

        // Set the facade segment as active again (the one created by AWS Lambda)
        tracer.setSegment(segment);
        // Publish all stored metrics
        metrics.publishStoredMetrics();
    }

    return response;
};
