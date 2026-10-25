/* Copyright (c) 2026, Oracle and/or its affiliates. */
import java.io.IOException;
import java.lang.instrument.ClassFileTransformer;
import java.lang.instrument.Instrumentation;
import java.net.URI;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.ProtectionDomain;
import jdk.internal.org.objectweb.asm.ClassReader;
import jdk.internal.org.objectweb.asm.ClassVisitor;
import jdk.internal.org.objectweb.asm.ClassWriter;
import jdk.internal.org.objectweb.asm.MethodVisitor;
import jdk.internal.org.objectweb.asm.Opcodes;

/** Hands the SDK's browser launch to SuiteContainer while retaining its OAuth flow. */
public final class BrowserHandoff
{
	private BrowserHandoff() {}

	/** Install the browser-launch adapter for this JVM only. */
	public static void premain(String arguments, Instrumentation instrumentation)
	{
		instrumentation.addTransformer(new ClassFileTransformer()
		{
			@Override
			public byte[] transform(ClassLoader loader, String name, Class<?> type,
					ProtectionDomain domain, byte[] bytes)
			{
				if (!name.equals("com/netsuite/ide/core/authentication/service/PKCERequestService"))
				{
					return null;
				}
				ClassWriter writer = new ClassWriter(ClassWriter.COMPUTE_MAXS);
				new ClassReader(bytes).accept(new ClassVisitor(Opcodes.ASM8, writer)
				{
					@Override
					public MethodVisitor visitMethod(int access, String name, String descriptor,
							String signature, String[] exceptions)
					{
						MethodVisitor method = super.visitMethod(access, name, descriptor, signature, exceptions);
						if (!name.equals("requestCodeGrant"))
						{
							return method;
						}
						method.visitCode();
						method.visitVarInsn(Opcodes.ALOAD, 1);
						method.visitMethodInsn(Opcodes.INVOKESTATIC, "BrowserHandoff", "open", "(Ljava/net/URI;)V", false);
						method.visitInsn(Opcodes.RETURN);
						method.visitMaxs(0, 0);
						method.visitEnd();
						return null;
					}
				}, 0);
				return writer.toByteArray();
			}
		});
	}

	/** Publish the complete URL atomically so the page cannot read a partial request. */
	public static void open(URI uri) throws IOException
	{
		Path destination = Path.of(System.getenv("SUITECONTAINER_BROWSER_URL_FILE"));
		Path temporary = destination.resolveSibling("browser-url.tmp");
		Files.writeString(temporary, uri.toString());
		Files.move(temporary, destination, StandardCopyOption.REPLACE_EXISTING);
	}
}
