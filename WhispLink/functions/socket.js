const { MongoClient } = require('mongodb');
const bcrypt = require('bcrypt');

const MONGODB_URI = process.env.MONGODB_URI;
const ABLY_API_KEY = process.env.ABLY_API_KEY;

let cachedDb = null;

async function connectToDatabase() {
  if (!MONGODB_URI) {
    throw new Error('MONGODB_URI is not configured');
  }
  if (cachedDb) return cachedDb;
  try {
    const client = new MongoClient(MONGODB_URI, { useNewUrlParser: true, useUnifiedTopology: true });
    await client.connect();
    cachedDb = client.db('whisplink');
    return cachedDb;
  } catch (error) {
    throw new Error(`MongoDB connection failed: ${error.message}`);
  }
}

exports.handler = async (event, context) => {
  context.callbackWaitsForEmptyEventLoop = false;

  const headers = {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*'
  };

  // Handle CORS preflight
  if (event.httpMethod === 'OPTIONS') {
    return {
      statusCode: 200,
      headers: {
        ...headers,
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
      },
      body: ''
    };
  }

  try {
    // Fetch Ably API Key
    if (event.httpMethod === 'GET' && event.queryStringParameters?.getAblyKey) {
      if (!ABLY_API_KEY) {
        return {
          statusCode: 500,
          headers,
          body: JSON.stringify({ error: 'Ably API key not configured' })
        };
      }
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ ablyKey: ABLY_API_KEY })
      };
    }

    // Handle POST requests
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }

    // Parse body safely
    let body;
    try {
      body = event.body ? JSON.parse(event.body) : {};
    } catch (error) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid JSON in request body' })
      };
    }

    const { action } = body;
    const db = await connectToDatabase();

    switch (action) {
      case 'login':
        const { handle, password } = body;
        if (!handle || !password) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Handle and password are required' })
          };
        }
        let user = await db.collection('users').findOne({ handle });
        if (!user) {
          // Create new user
          const hashedPassword = await bcrypt.hash(password, 10);
          await db.collection('users').insertOne({
            handle,
            password: hashedPassword,
            online: true,
            lastSeen: 'Online',
            createdAt: new Date()
          });
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true, created: true })
          };
        }
        const isPasswordValid = await bcrypt.compare(password, user.password);
        if (!isPasswordValid) {
          return {
            statusCode: 401,
            headers,
            body: JSON.stringify({ success: false, message: 'Invalid password' })
          };
        }
        await db.collection('users').updateOne(
          { handle },
          { $set: { online: true, lastSeen: 'Online' } }
        );
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, created: false })
        };

      case 'search':
        const { query } = body;
        if (!query) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Query is required' })
          };
        }
        const userSearch = await db.collection('users').findOne({ handle: query });
        if (userSearch) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              success: true,
              isGroup: false,
              lastSeen: userSearch.lastSeen
            })
          };
        }
        const group = await db.collection('groups').findOne({ name: query });
        if (group) {
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({
              success: true,
              isGroup: true,
              members: group.members
            })
          };
        }
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ success: false, message: 'User or group not found' })
        };

      case 'sendMessage':
        const { chatId, message } = body;
        if (!chatId || !message) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Chat ID and message are required' })
          };
        }
        await db.collection('messages').insertOne({
          chatId,
          message,
          createdAt: new Date()
        });
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true })
        };

      case 'markAsRead':
        const { chatId: readChatId, message: readMessage } = body;
        if (!readChatId || !readMessage) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Chat ID and message are required' })
          };
        }
        await db.collection('messages').updateOne(
          { chatId: readChatId, 'message.timestamp': readMessage.timestamp },
          { $set: { 'message.read': true } }
        );
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true })
        };

      case 'editMessage':
        const { chatId: editChatId, index, content } = body;
        if (!editChatId || index == null || !content) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Chat ID, index, and content are required' })
          };
        }
        const messageToEdit = await db.collection('messages').findOne(
          { chatId: editChatId },
          { sort: { createdAt: 1 }, skip: index, limit: 1 }
        );
        if (messageToEdit) {
          await db.collection('messages').updateOne(
            { _id: messageToEdit._id },
            { $set: { 'message.content': content } }
          );
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true })
          };
        }
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ success: false, message: 'Message not found' })
        };

      case 'deleteMessage':
        const { chatId: deleteChatId, index: deleteIndex } = body;
        if (!deleteChatId || deleteIndex == null) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Chat ID and index are required' })
          };
        }
        const messageToDelete = await db.collection('messages').findOne(
          { chatId: deleteChatId },
          { sort: { createdAt: 1 }, skip: deleteIndex, limit: 1 }
        );
        if (messageToDelete) {
          await db.collection('messages').deleteOne({ _id: messageToDelete._id });
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true })
          };
        }
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ success: false, message: 'Message not found' })
        };

      case 'addReaction':
        const { chatId: reactionChatId, index: reactionIndex, reaction } = body;
        if (!reactionChatId || reactionIndex == null || !reaction) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Chat ID, index, and reaction are required' })
          };
        }
        const messageToReact = await db.collection('messages').findOne(
          { chatId: reactionChatId },
          { sort: { createdAt: 1 }, skip: reactionIndex, limit: 1 }
        );
        if (messageToReact) {
          await db.collection('messages').updateOne(
            { _id: messageToReact._id },
            { $push: { 'message.reactions': reaction } }
          );
          return {
            statusCode: 200,
            headers,
            body: JSON.stringify({ success: true })
          };
        }
        return {
          statusCode: 404,
          headers,
          body: JSON.stringify({ success: false, message: 'Message not found' })
        };

      case 'createGroup':
        const { groupName, members } = body;
        if (!groupName || !members || members.length < 2 || members.length > 5) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Group name and 2-5 members are required' })
          };
        }
        const existingGroup = await db.collection('groups').findOne({ name: groupName });
        if (existingGroup) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Group name already exists' })
          };
        }
        const validMembers = await db.collection('users').find({ handle: { $in: members } }).toArray();
        if (validMembers.length !== members.length) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'One or more members not found' })
          };
        }
        await db.collection('groups').insertOne({
          name: groupName,
          members,
          createdAt: new Date()
        });
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, members })
        };

      case 'getChats':
        const { user } = body;
        if (!user) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'User is required' })
          };
        }
        const userChats = await db.collection('messages').aggregate([
          { $match: { chatId: { $regex: `^${user}-|-${user}$|^${user}-` } } },
          { $group: { _id: '$chatId', lastMessage: { $last: '$message' } } }
        ]).toArray();
        const groups = await db.collection('groups').find({ members: user }).toArray();
        const chats = await Promise.all(userChats.map(async chat => {
          const isGroup = chat._id.includes(user + '-');
          let name, lastSeen, members = [];
          if (isGroup) {
            const group = groups.find(g => g.name === chat._id.split('-')[1]);
            name = group?.name || chat._id;
            members = group?.members || [];
            lastSeen = '';
          } else {
            name = chat._id.replace(user, '').replace('-', '');
            const otherUser = await db.collection('users').findOne({ handle: name });
            lastSeen = otherUser?.lastSeen || 'Offline';
          }
          return {
            chatId: chat._id,
            name,
            isGroup,
            lastSeen,
            members
          };
        }));
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true, chats })
        };

      case 'exportData':
        const { user: exportUser } = body;
        if (!exportUser) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'User is required' })
          };
        }
        const exportMessages = await db.collection('messages').find({ chatId: { $regex: `^${exportUser}-|-${exportUser}$|^${exportUser}-` } }).toArray();
        const exportGroups = await db.collection('groups').find({ members: exportUser }).toArray();
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            data: { messages: exportMessages, groups: exportGroups }
          })
        };

      case 'importData':
        const { user: importUser, data } = body;
        if (!importUser || !data) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'User and data are required' })
          };
        }
        await db.collection('messages').deleteMany({ chatId: { $regex: `^${importUser}-|-${importUser}$|^${importUser}-` } });
        await db.collection('groups').deleteMany({ members: importUser });
        if (data.messages) {
          await db.collection('messages').insertMany(data.messages);
        }
        if (data.groups) {
          await db.collection('groups').insertMany(data.groups);
        }
        const importMessages = await db.collection('messages').find({ chatId: { $regex: `^${importUser}-|-${importUser}$|^${importUser}-` } }).toArray();
        const importGroups = await db.collection('groups').find({ members: importUser }).toArray();
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({
            success: true,
            messages: importMessages,
            groups: importGroups
          })
        };

      case 'updateStatus':
        const { handle: statusHandle, online, lastSeen } = body;
        if (!statusHandle) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Handle is required' })
          };
        }
        await db.collection('users').updateOne(
          { handle: statusHandle },
          { $set: { online, lastSeen } }
        );
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true })
        };

      case 'updateProfile':
        const { oldHandle, newHandle, newPassword } = body;
        if (!oldHandle || (!newHandle && !newPassword)) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Old handle and at least one update field are required' })
          };
        }
        const existingUser = await db.collection('users').findOne({ handle: newHandle });
        if (existingUser && newHandle !== oldHandle) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Handle already taken' })
          };
        }
        const updateFields = {};
        if (newHandle) updateFields.handle = newHandle;
        if (newPassword) updateFields.password = await bcrypt.hash(newPassword, 10);
        await db.collection('users').updateOne(
          { handle: oldHandle },
          { $set: updateFields }
        );
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true })
        };

      case 'clearChat':
        const { chatId: clearChatId } = body;
        if (!clearChatId) {
          return {
            statusCode: 400,
            headers,
            body: JSON.stringify({ error: 'Chat ID is required' })
          };
        }
        await db.collection('messages').deleteMany({ chatId: clearChatId });
        return {
          statusCode: 200,
          headers,
          body: JSON.stringify({ success: true })
        };

      default:
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ error: 'Invalid action' })
        };
    }
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ error: `Internal server error: ${error.message}` })
    };
  }
};